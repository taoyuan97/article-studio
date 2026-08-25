from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from article_agent.models import ArticleBrief, ArticleResult


SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    brief_json TEXT NOT NULL,
    conversation_summary TEXT,
    summary_until_message_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft','generated','running','failed')),
    current_version_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL UNIQUE REFERENCES articles(id),
    thread_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    run_id TEXT,
    sequence_number INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    message_type TEXT NOT NULL CHECK (message_type IN ('chat','clarification','redirect','generation','revision','error')),
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed','failed')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(conversation_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS article_versions (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id),
    parent_version_id TEXT,
    version_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content_markdown TEXT NOT NULL,
    instruction TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE(article_id, version_number)
);

CREATE TABLE IF NOT EXISTS generation_runs (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    user_message_id TEXT NOT NULL REFERENCES messages(id),
    assistant_message_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed')),
    started_at TEXT,
    first_token_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    error_code TEXT,
    error_message TEXT,
    raw_provider_error TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER
);

CREATE TABLE IF NOT EXISTS image_generation_sessions (
    id TEXT PRIMARY KEY,
    article_id TEXT REFERENCES articles(id),
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('idle','running','failed','completed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_generation_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES image_generation_sessions(id),
    sequence_number INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    image_url TEXT,
    image_prompt TEXT,
    status TEXT NOT NULL CHECK (status IN ('completed','failed')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS image_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES image_generation_sessions(id),
    user_message_id TEXT NOT NULL REFERENCES image_generation_messages(id),
    assistant_message_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed')),
    started_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    error_message TEXT,
    raw_provider_error TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('image','audio')),
    source TEXT NOT NULL CHECK (source IN ('image_generation','upload')),
    source_session_id TEXT REFERENCES image_generation_sessions(id),
    source_message_id TEXT REFERENCES image_generation_messages(id),
    title TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_records (
    id TEXT PRIMARY KEY,
    article_id TEXT NOT NULL REFERENCES articles(id),
    version_id TEXT REFERENCES article_versions(id),
    theme_id TEXT NOT NULL,
    cover_asset_id TEXT REFERENCES assets(id),
    author TEXT,
    digest TEXT,
    image_placements_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
    media_id TEXT,
    error_code TEXT,
    error_message TEXT,
    content_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES image_generation_sessions(id),
    article_id TEXT,
    version_id TEXT,
    role TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed','failed')),
    result_json TEXT,
    error_message TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_updated ON articles(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence ON messages(conversation_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_versions_article_number ON article_versions(article_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_runs_article_status ON generation_runs(article_id, status);
CREATE INDEX IF NOT EXISTS idx_image_sessions_article ON image_generation_sessions(article_id);
CREATE INDEX IF NOT EXISTS idx_image_sessions_updated ON image_generation_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_messages_session ON image_generation_messages(session_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_image_runs_session_status ON image_runs(session_id, status);
CREATE INDEX IF NOT EXISTS idx_image_plans_session ON image_plans(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_kind_updated ON assets(kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_source_session ON assets(source_session_id);
CREATE INDEX IF NOT EXISTS idx_publish_records_article ON publish_records(article_id, created_at DESC);
"""


class NotFoundError(LookupError):
    pass


class RunNotActiveError(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def _display_title(content: str, limit: int = 40) -> str:
    compact = " ".join(content.split())
    return compact if len(compact) <= limit else compact[:limit].rstrip() + "…"


class Repository:
    def __init__(self, path: Path | str):
        self.path = Path(path)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(SCHEMA)

    def recover_stale_runs(self) -> None:
        timestamp = now_iso()
        with self.transaction() as connection:
            connection.execute(
                """UPDATE generation_runs
                   SET status='failed', completed_at=?, error_code='RUN_INTERRUPTED',
                       error_message='服务重启，运行已中断。', raw_provider_error='process restarted'
                   WHERE status IN ('queued','running')""",
                (timestamp,),
            )
            connection.execute(
                """UPDATE articles SET status='failed', updated_at=?
                   WHERE status='running'""",
                (timestamp,),
            )

    def create_article(self, provider: str, model: str) -> dict[str, Any]:
        article_id = str(uuid4())
        conversation_id = str(uuid4())
        thread_id = str(uuid4())
        timestamp = now_iso()
        with self.transaction() as connection:
            connection.execute(
                """INSERT INTO articles
                   (id,conversation_id,title,brief_json,status,provider,model,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    article_id,
                    conversation_id,
                    "未命名文章",
                    ArticleBrief().model_dump_json(),
                    "draft",
                    provider,
                    model,
                    timestamp,
                    timestamp,
                ),
            )
            connection.execute(
                """INSERT INTO conversations (id,article_id,thread_id,created_at,updated_at)
                   VALUES (?,?,?,?,?)""",
                (conversation_id, article_id, thread_id, timestamp, timestamp),
            )
        return self.get_article(article_id)

    def get_article(self, article_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT a.*, c.thread_id
                   FROM articles a JOIN conversations c ON c.id=a.conversation_id
                   WHERE a.id=?""",
                (article_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("文章不存在")
        result = dict(row)
        result["brief"] = json.loads(result.pop("brief_json"))
        return result

    def list_articles(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT a.id,a.title,a.status,a.provider,a.model,a.created_at,a.updated_at,
                          COUNT(DISTINCT v.id) AS version_count,
                          COALESCE(SUBSTR(cv.content_markdown,1,160),
                            (SELECT SUBSTR(m.content,1,160) FROM messages m
                             WHERE m.conversation_id=a.conversation_id AND m.role='user'
                             ORDER BY m.sequence_number LIMIT 1), '') AS summary
                   FROM articles a
                   LEFT JOIN article_versions v ON v.article_id=a.id
                   LEFT JOIN article_versions cv ON cv.id=a.current_version_id
                   GROUP BY a.id ORDER BY a.updated_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_model(self, article_id: str, provider: str, model: str) -> dict[str, Any]:
        timestamp = now_iso()
        with self.transaction() as connection:
            cursor = connection.execute(
                "UPDATE articles SET provider=?,model=?,updated_at=? WHERE id=?",
                (provider, model, timestamp, article_id),
            )
            if cursor.rowcount == 0:
                raise NotFoundError("文章不存在")
        return self.get_article(article_id)

    @staticmethod
    def _next_sequence(connection: sqlite3.Connection, conversation_id: str) -> int:
        row = connection.execute(
            "SELECT COALESCE(MAX(sequence_number),0)+1 AS value FROM messages WHERE conversation_id=?",
            (conversation_id,),
        ).fetchone()
        return int(row["value"])

    def create_run(
        self,
        article_id: str,
        *,
        content: str | None = None,
        retry_message_id: str | None = None,
    ) -> dict[str, Any]:
        run_id = str(uuid4())
        timestamp = now_iso()
        with self.transaction() as connection:
            article = connection.execute(
                "SELECT * FROM articles WHERE id=?", (article_id,)
            ).fetchone()
            if article is None:
                raise NotFoundError("文章不存在")
            active = connection.execute(
                """SELECT id FROM generation_runs
                   WHERE article_id=? AND status IN ('queued','running')""",
                (article_id,),
            ).fetchone()
            if active:
                raise RunNotActiveError("ARTICLE_RUN_ACTIVE")
            if retry_message_id:
                user = connection.execute(
                    """SELECT * FROM messages
                       WHERE id=? AND conversation_id=? AND role='user'
                         AND EXISTS (
                           SELECT 1 FROM generation_runs r
                           WHERE r.user_message_id=messages.id AND r.status='failed'
                         )""",
                    (retry_message_id, article["conversation_id"]),
                ).fetchone()
                if user is None:
                    raise NotFoundError("原用户消息不存在")
                user_message_id = user["id"]
            else:
                if content is None or not content.strip():
                    raise ValueError("消息内容不能为空")
                user_message_id = str(uuid4())
                sequence = self._next_sequence(connection, article["conversation_id"])
                connection.execute(
                    """INSERT INTO messages
                       (id,conversation_id,run_id,sequence_number,role,message_type,content,status,provider,model,created_at,completed_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        user_message_id,
                        article["conversation_id"],
                        run_id,
                        sequence,
                        "user",
                        "chat",
                        content.strip(),
                        "completed",
                        article["provider"],
                        article["model"],
                        timestamp,
                        timestamp,
                    ),
                )
                if article["title"] == "未命名文章" and not article["current_version_id"]:
                    connection.execute(
                        "UPDATE articles SET title=? WHERE id=?",
                        (_display_title(content), article_id),
                    )
            connection.execute(
                """INSERT INTO generation_runs
                   (id,article_id,conversation_id,user_message_id,provider,model,status)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    run_id,
                    article_id,
                    article["conversation_id"],
                    user_message_id,
                    article["provider"],
                    article["model"],
                    "queued",
                ),
            )
            connection.execute(
                "UPDATE articles SET status='running',updated_at=? WHERE id=?",
                (timestamp, article_id),
            )
            connection.execute(
                "UPDATE conversations SET updated_at=? WHERE id=?",
                (timestamp, article["conversation_id"]),
            )
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT r.*,m.content AS instruction,c.thread_id
                   FROM generation_runs r
                   JOIN messages m ON m.id=r.user_message_id
                   JOIN conversations c ON c.id=r.conversation_id
                   WHERE r.id=?""",
                (run_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("运行不存在")
        return dict(row)

    def mark_run_running(self, run_id: str) -> None:
        with self.transaction() as connection:
            connection.execute(
                "UPDATE generation_runs SET status='running',started_at=? WHERE id=? AND status='queued'",
                (now_iso(), run_id),
            )

    def mark_first_token(self, run_id: str) -> None:
        with self.transaction() as connection:
            connection.execute(
                "UPDATE generation_runs SET first_token_at=COALESCE(first_token_at,?) WHERE id=?",
                (now_iso(), run_id),
            )

    def _update_article_state(
        self,
        connection: sqlite3.Connection,
        article_id: str,
        *,
        brief: ArticleBrief,
        summary: str | None,
        summary_until: str | None,
        status: str,
        timestamp: str,
    ) -> None:
        connection.execute(
            """UPDATE articles SET brief_json=?,conversation_summary=?,
                      summary_until_message_id=?,status=?,updated_at=? WHERE id=?""",
            (
                brief.model_dump_json(),
                summary,
                summary_until,
                status,
                timestamp,
                article_id,
            ),
        )

    def complete_chat(
        self,
        run_id: str,
        *,
        content: str,
        message_type: str,
        brief: ArticleBrief,
        summary: str | None,
        summary_until: str | None,
        usage: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timestamp = now_iso()
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT * FROM generation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                raise NotFoundError("运行不存在")
            if run["status"] == "completed" and run["assistant_message_id"]:
                row = connection.execute(
                    "SELECT * FROM messages WHERE id=?", (run["assistant_message_id"],)
                ).fetchone()
                return dict(row)
            if run["status"] != "running":
                raise RunNotActiveError("运行已取消或不再活动")
            sequence = self._next_sequence(connection, run["conversation_id"])
            message_id = str(uuid4())
            connection.execute(
                """INSERT INTO messages
                   (id,conversation_id,run_id,sequence_number,role,message_type,content,status,provider,model,created_at,completed_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    message_id,
                    run["conversation_id"],
                    run_id,
                    sequence,
                    "assistant",
                    message_type,
                    content,
                    "completed",
                    run["provider"],
                    run["model"],
                    timestamp,
                    timestamp,
                ),
            )
            current = connection.execute(
                "SELECT current_version_id FROM articles WHERE id=?", (run["article_id"],)
            ).fetchone()
            status = "generated" if current["current_version_id"] else "draft"
            self._update_article_state(
                connection,
                run["article_id"],
                brief=brief,
                summary=summary,
                summary_until=summary_until,
                status=status,
                timestamp=timestamp,
            )
            connection.execute(
                """UPDATE generation_runs SET status='completed',assistant_message_id=?,completed_at=?
                      ,input_tokens=?,output_tokens=? WHERE id=?""",
                (
                    message_id,
                    timestamp,
                    usage.get("input_tokens") if usage else None,
                    usage.get("output_tokens") if usage else None,
                    run_id,
                ),
            )
        return self.get_message(message_id)

    def persist_version(
        self,
        run_id: str,
        *,
        result: ArticleResult,
        brief: ArticleBrief,
        summary: str | None,
        summary_until: str | None,
        usage: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        timestamp = now_iso()
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT * FROM generation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                raise NotFoundError("运行不存在")
            existing = connection.execute(
                "SELECT * FROM article_versions WHERE run_id=?", (run_id,)
            ).fetchone()
            if existing:
                message = connection.execute(
                    "SELECT * FROM messages WHERE id=?", (run["assistant_message_id"],)
                ).fetchone()
                return dict(existing), dict(message)
            if run["status"] != "running":
                raise RunNotActiveError("运行已取消或不再活动")
            article = connection.execute(
                "SELECT * FROM articles WHERE id=?", (run["article_id"],)
            ).fetchone()
            version_number = int(
                connection.execute(
                    "SELECT COALESCE(MAX(version_number),0)+1 AS value FROM article_versions WHERE article_id=?",
                    (run["article_id"],),
                ).fetchone()["value"]
            )
            version_id = str(uuid4())
            connection.execute(
                """INSERT INTO article_versions
                   (id,article_id,parent_version_id,version_number,title,content_markdown,instruction,provider,model,run_id,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    version_id,
                    run["article_id"],
                    article["current_version_id"],
                    version_number,
                    result.title,
                    result.content_markdown,
                    connection.execute(
                        "SELECT content FROM messages WHERE id=?", (run["user_message_id"],)
                    ).fetchone()["content"],
                    run["provider"],
                    run["model"],
                    run_id,
                    timestamp,
                ),
            )
            message_id = str(uuid4())
            sequence = self._next_sequence(connection, run["conversation_id"])
            message_type = "revision" if result.kind == "revision" else "generation"
            connection.execute(
                """INSERT INTO messages
                   (id,conversation_id,run_id,sequence_number,role,message_type,content,status,provider,model,created_at,completed_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    message_id,
                    run["conversation_id"],
                    run_id,
                    sequence,
                    "assistant",
                    message_type,
                    result.content_markdown,
                    "completed",
                    run["provider"],
                    run["model"],
                    timestamp,
                    timestamp,
                ),
            )
            connection.execute(
                """UPDATE articles SET current_version_id=?,title=?,brief_json=?,
                      conversation_summary=?,summary_until_message_id=?,status='generated',updated_at=?
                   WHERE id=?""",
                (
                    version_id,
                    result.title,
                    brief.model_dump_json(),
                    summary,
                    summary_until,
                    timestamp,
                    run["article_id"],
                ),
            )
            connection.execute(
                """UPDATE generation_runs SET status='completed',assistant_message_id=?,completed_at=?
                      ,input_tokens=?,output_tokens=? WHERE id=?""",
                (
                    message_id,
                    timestamp,
                    usage.get("input_tokens") if usage else None,
                    usage.get("output_tokens") if usage else None,
                    run_id,
                ),
            )
            version = connection.execute(
                "SELECT * FROM article_versions WHERE id=?", (version_id,)
            ).fetchone()
            message = connection.execute(
                "SELECT * FROM messages WHERE id=?", (message_id,)
            ).fetchone()
        return dict(version), dict(message)

    def cancel_run(self, run_id: str) -> bool:
        timestamp = now_iso()
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT * FROM generation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                raise NotFoundError("运行不存在")
            if run["status"] not in ("queued", "running"):
                return False
            connection.execute(
                "UPDATE generation_runs SET status='cancelled',cancelled_at=? WHERE id=?",
                (timestamp, run_id),
            )
            article = connection.execute(
                "SELECT current_version_id FROM articles WHERE id=?", (run["article_id"],)
            ).fetchone()
            connection.execute(
                "UPDATE articles SET status=?,updated_at=? WHERE id=?",
                (
                    "generated" if article["current_version_id"] else "draft",
                    timestamp,
                    run["article_id"],
                ),
            )
        return True

    def fail_run(
        self,
        run_id: str,
        *,
        message: str,
        detail: str,
        error_code: str,
    ) -> dict[str, Any] | None:
        timestamp = now_iso()
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT * FROM generation_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                raise NotFoundError("运行不存在")
            if run["status"] not in ("queued", "running"):
                return None
            message_id = str(uuid4())
            sequence = self._next_sequence(connection, run["conversation_id"])
            connection.execute(
                """INSERT INTO messages
                   (id,conversation_id,run_id,sequence_number,role,message_type,content,status,provider,model,created_at,completed_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    message_id,
                    run["conversation_id"],
                    run_id,
                    sequence,
                    "assistant",
                    "error",
                    message,
                    "failed",
                    run["provider"],
                    run["model"],
                    timestamp,
                    timestamp,
                ),
            )
            connection.execute(
                """UPDATE generation_runs SET status='failed',assistant_message_id=?,completed_at=?,
                      error_code=?,error_message=?,raw_provider_error=? WHERE id=?""",
                (message_id, timestamp, error_code, message, detail, run_id),
            )
            connection.execute(
                "UPDATE articles SET status='failed',updated_at=? WHERE id=?",
                (timestamp, run["article_id"]),
            )
            row = connection.execute(
                "SELECT * FROM messages WHERE id=?", (message_id,)
            ).fetchone()
        return dict(row)

    def get_message(self, message_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM messages WHERE id=?", (message_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError("消息不存在")
        return dict(row)

    def list_messages(
        self, article_id: str, *, before: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        article = self.get_article(article_id)
        params: list[Any] = [article["conversation_id"]]
        if before:
            cursor = self.get_message(before)
            if cursor["conversation_id"] != article["conversation_id"]:
                raise NotFoundError("消息游标不存在")
            params.append(cursor["sequence_number"])
        params.append(limit)
        with self.connect() as connection:
            if before:
                rows = connection.execute(
                    """SELECT m.*,r.error_code,r.error_message,
                              r.raw_provider_error AS provider_detail,
                              CASE WHEN r.status='failed' THEN 1 ELSE 0 END AS retryable,
                              r.user_message_id
                       FROM messages m LEFT JOIN generation_runs r
                         ON r.id=m.run_id AND m.role='assistant'
                       WHERE m.conversation_id=? AND m.sequence_number < ?
                       ORDER BY m.sequence_number DESC LIMIT ?""",
                    params,
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT m.*,r.error_code,r.error_message,
                              r.raw_provider_error AS provider_detail,
                              CASE WHEN r.status='failed' THEN 1 ELSE 0 END AS retryable,
                              r.user_message_id
                       FROM messages m LEFT JOIN generation_runs r
                         ON r.id=m.run_id AND m.role='assistant'
                       WHERE m.conversation_id=?
                       ORDER BY m.sequence_number DESC LIMIT ?""",
                    params,
                ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def list_versions(self, article_id: str) -> list[dict[str, Any]]:
        self.get_article(article_id)
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT id,article_id,parent_version_id,version_number,title,provider,model,run_id,created_at
                   FROM article_versions WHERE article_id=? ORDER BY version_number DESC""",
                (article_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_version(self, article_id: str, version_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM article_versions WHERE id=? AND article_id=?",
                (version_id, article_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("版本不存在")
        return dict(row)

    def workspace(self, article_id: str) -> dict[str, Any]:
        article = self.get_article(article_id)
        current = (
            self.get_version(article_id, article["current_version_id"])
            if article["current_version_id"]
            else None
        )
        return {
            "article": article,
            "current_version": current,
            "messages": self.list_messages(article_id, limit=10000),
            "versions": self.list_versions(article_id),
        }

    def get_stats(self) -> dict[str, Any]:
        with self.connect() as connection:
            article_count = connection.execute(
                "SELECT COUNT(*) AS value FROM articles"
            ).fetchone()["value"]
            asset_count = connection.execute(
                "SELECT COUNT(*) AS value FROM assets WHERE kind='image'"
            ).fetchone()["value"]
            recent_articles = connection.execute(
                """SELECT a.id, a.title, a.updated_at,
                          COUNT(DISTINCT v.id) AS version_count
                   FROM articles a
                   LEFT JOIN article_versions v ON v.article_id=a.id
                   GROUP BY a.id
                   ORDER BY a.updated_at DESC LIMIT 5"""
            ).fetchall()
            recent_assets = connection.execute(
                """SELECT id, title, storage_url, updated_at
                   FROM assets
                   WHERE kind='image'
                   ORDER BY updated_at DESC LIMIT 5"""
            ).fetchall()
        return {
            "article_count": article_count,
            "asset_count": asset_count,
            "recent_articles": [dict(row) for row in recent_articles],
            "recent_assets": [dict(row) for row in recent_assets],
        }

    def _next_image_sequence(self, connection: sqlite3.Connection, session_id: str) -> int:
        row = connection.execute(
            "SELECT COALESCE(MAX(sequence_number),0)+1 AS value FROM image_generation_messages WHERE session_id=?",
            (session_id,),
        ).fetchone()
        return int(row["value"])

    def create_image_session(
        self,
        *,
        provider: str,
        model: str,
        article_id: str | None = None,
    ) -> dict[str, Any]:
        session_id = str(uuid4())
        timestamp = now_iso()
        with self.transaction() as connection:
            if article_id:
                article = connection.execute(
                    "SELECT id FROM articles WHERE id=?", (article_id,)
                ).fetchone()
                if article is None:
                    raise NotFoundError("文章不存在")
            connection.execute(
                """INSERT INTO image_generation_sessions
                   (id,article_id,title,provider,model,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (session_id, article_id, "未命名配图", provider, model, "idle", timestamp, timestamp),
            )
        return self.get_image_session(session_id)

    def get_image_session(self, session_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT s.*, a.title AS article_title
                   FROM image_generation_sessions s
                   LEFT JOIN articles a ON a.id=s.article_id
                   WHERE s.id=?""",
                (session_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("配图会话不存在")
        return dict(row)

    def list_image_sessions(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT s.id, s.title, s.article_id, a.title AS article_title,
                          s.provider, s.model, s.status, s.updated_at
                   FROM image_generation_sessions s
                   LEFT JOIN articles a ON a.id=s.article_id
                   ORDER BY s.updated_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_image_session_title(
        self, session_id: str, title: str
    ) -> dict[str, Any]:
        timestamp = now_iso()
        with self.transaction() as connection:
            cursor = connection.execute(
                "UPDATE image_generation_sessions SET title=?, updated_at=? WHERE id=?",
                (title, timestamp, session_id),
            )
            if cursor.rowcount == 0:
                raise NotFoundError("配图会话不存在")
        return self.get_image_session(session_id)

    def create_image_run(
        self,
        session_id: str,
        *,
        content: str,
        provider: str,
        model: str,
        size: str | None = None,
        tier: str | None = None,
        ratio: str | None = None,
    ) -> dict[str, Any]:
        run_id = str(uuid4())
        message_id = str(uuid4())
        timestamp = now_iso()
        metadata = {"size": size, "tier": tier, "ratio": ratio}
        with self.transaction() as connection:
            session = connection.execute(
                "SELECT * FROM image_generation_sessions WHERE id=?", (session_id,)
            ).fetchone()
            if session is None:
                raise NotFoundError("配图会话不存在")
            active = connection.execute(
                """SELECT id FROM image_runs
                   WHERE session_id=? AND status IN ('queued','running')""",
                (session_id,),
            ).fetchone()
            if active:
                raise RunNotActiveError("IMAGE_RUN_ACTIVE")
            sequence = self._next_image_sequence(connection, session_id)
            connection.execute(
                """INSERT INTO image_generation_messages
                   (id,session_id,sequence_number,role,content,status,provider,model,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    message_id,
                    session_id,
                    sequence,
                    "user",
                    content.strip(),
                    "completed",
                    provider,
                    model,
                    timestamp,
                ),
            )
            connection.execute(
                """INSERT INTO image_runs
                   (id,session_id,user_message_id,provider,model,status,metadata_json)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    run_id,
                    session_id,
                    message_id,
                    provider,
                    model,
                    "queued",
                    json.dumps(metadata, ensure_ascii=False),
                ),
            )
            connection.execute(
                "UPDATE image_generation_sessions SET status='running',updated_at=? WHERE id=?",
                (timestamp, session_id),
            )
        return self.get_image_run(run_id)

    def get_image_run(self, run_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT r.*, m.content AS instruction, s.article_id
                   FROM image_runs r
                   JOIN image_generation_messages m ON m.id=r.user_message_id
                   JOIN image_generation_sessions s ON s.id=r.session_id
                   WHERE r.id=?""",
                (run_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("运行不存在")
        result = dict(row)
        metadata = json.loads(result.pop("metadata_json") or "{}")
        result.update(metadata)
        return result

    def mark_image_run_running(self, run_id: str) -> None:
        with self.transaction() as connection:
            connection.execute(
                "UPDATE image_runs SET status='running',started_at=? WHERE id=? AND status='queued'",
                (now_iso(), run_id),
            )

    def complete_image_run(
        self,
        run_id: str,
        *,
        image_url: str,
        image_prompt: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timestamp = now_iso()
        metadata = metadata or {}
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT * FROM image_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                raise NotFoundError("运行不存在")
            if run["status"] != "running":
                raise RunNotActiveError("运行已取消或不再活动")
            existing_metadata = json.loads(run["metadata_json"] or "{}")
            message_id = str(uuid4())
            sequence = self._next_image_sequence(connection, run["session_id"])
            connection.execute(
                """INSERT INTO image_generation_messages
                   (id,session_id,sequence_number,role,content,image_url,image_prompt,status,provider,model,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    message_id,
                    run["session_id"],
                    sequence,
                    "assistant",
                    "已生成图片",
                    image_url,
                    image_prompt,
                    "completed",
                    run["provider"],
                    run["model"],
                    timestamp,
                ),
            )
            merged_metadata = {**existing_metadata, **metadata}
            connection.execute(
                """UPDATE image_runs
                   SET status='completed',assistant_message_id=?,completed_at=?,metadata_json=?
                   WHERE id=?""",
                (message_id, timestamp, json.dumps(merged_metadata, ensure_ascii=False), run_id),
            )
            connection.execute(
                """UPDATE image_generation_sessions
                   SET status='completed',updated_at=? WHERE id=?""",
                (timestamp, run["session_id"]),
            )
            message = connection.execute(
                "SELECT * FROM image_generation_messages WHERE id=?", (message_id,)
            ).fetchone()
        return dict(message)

    def cancel_image_run(self, run_id: str) -> bool:
        timestamp = now_iso()
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT * FROM image_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                raise NotFoundError("运行不存在")
            if run["status"] not in ("queued", "running"):
                return False
            connection.execute(
                "UPDATE image_runs SET status='cancelled',cancelled_at=? WHERE id=?",
                (timestamp, run_id),
            )
            connection.execute(
                """UPDATE image_generation_sessions
                   SET status='idle',updated_at=? WHERE id=?""",
                (timestamp, run["session_id"]),
            )
        return True

    def fail_image_run(
        self, run_id: str, *, message: str, detail: str
    ) -> dict[str, Any] | None:
        timestamp = now_iso()
        with self.transaction() as connection:
            run = connection.execute(
                "SELECT * FROM image_runs WHERE id=?", (run_id,)
            ).fetchone()
            if run is None:
                raise NotFoundError("运行不存在")
            if run["status"] not in ("queued", "running"):
                return None
            message_id = str(uuid4())
            sequence = self._next_image_sequence(connection, run["session_id"])
            connection.execute(
                """INSERT INTO image_generation_messages
                   (id,session_id,sequence_number,role,content,status,provider,model,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    message_id,
                    run["session_id"],
                    sequence,
                    "assistant",
                    message,
                    "failed",
                    run["provider"],
                    run["model"],
                    timestamp,
                ),
            )
            connection.execute(
                """UPDATE image_runs
                   SET status='failed',assistant_message_id=?,completed_at=?,error_message=?,raw_provider_error=?
                   WHERE id=?""",
                (message_id, timestamp, message, detail, run_id),
            )
            connection.execute(
                """UPDATE image_generation_sessions
                   SET status='failed',updated_at=? WHERE id=?""",
                (timestamp, run["session_id"]),
            )
            row = connection.execute(
                "SELECT * FROM image_generation_messages WHERE id=?", (message_id,)
            ).fetchone()
        return dict(row)

    def list_image_messages(self, session_id: str) -> list[dict[str, Any]]:
        self.get_image_session(session_id)
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT * FROM image_generation_messages
                   WHERE session_id=? ORDER BY sequence_number ASC""",
                (session_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def image_workspace(self, session_id: str) -> dict[str, Any]:
        session = self.get_image_session(session_id)
        return {
            "session": session,
            "messages": self.list_image_messages(session_id),
        }

    def get_image_message(self, session_id: str, message_id: str) -> dict[str, Any] | None:
        self.get_image_session(session_id)
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM image_generation_messages WHERE id=? AND session_id=?",
                (message_id, session_id),
            ).fetchone()
        return _dict(row)

    def save_image_plan(
        self,
        session_id: str,
        *,
        article_id: str,
        version_id: str,
        role: str,
        instructions: str,
        result: dict[str, Any],
        provider: str,
        model: str,
    ) -> dict[str, Any]:
        """覆盖式保存会话最近一次配图方案；result_json 存完整响应载荷（含统计）。"""
        plan_id = str(uuid4())
        with self.transaction() as connection:
            session = connection.execute(
                "SELECT id FROM image_generation_sessions WHERE id=?", (session_id,)
            ).fetchone()
            if session is None:
                raise NotFoundError("配图会话不存在")
            connection.execute(
                "DELETE FROM image_plans WHERE session_id=?", (session_id,)
            )
            connection.execute(
                """INSERT INTO image_plans
                   (id,session_id,article_id,version_id,role,instructions,status,
                    result_json,provider,model,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    plan_id,
                    session_id,
                    article_id,
                    version_id,
                    role,
                    instructions,
                    "completed",
                    json.dumps(result, ensure_ascii=False),
                    provider,
                    model,
                    now_iso(),
                ),
            )
        return self.get_image_plan(session_id)

    def get_image_plan(self, session_id: str) -> dict[str, Any] | None:
        """会话最近一次配图方案；result 字段为完整响应载荷，无记录返回 None。"""
        with self.connect() as connection:
            row = connection.execute(
                """SELECT id,session_id,article_id,version_id,role,instructions,status,
                          result_json,provider,model,created_at
                   FROM image_plans WHERE session_id=?
                   ORDER BY created_at DESC LIMIT 1""",
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["result"] = json.loads(item.pop("result_json") or "null")
        return item

    def create_asset(
        self,
        *,
        source_session_id: str,
        source_message_id: str,
        title: str,
    ) -> dict[str, Any]:
        timestamp = now_iso()
        with self.transaction() as connection:
            # Idempotency: return existing asset for the same source message.
            existing = connection.execute(
                "SELECT id FROM assets WHERE source_message_id=?", (source_message_id,)
            ).fetchone()
            if existing:
                return self.get_asset(existing["id"])

            message = connection.execute(
                """SELECT m.*, s.provider AS session_provider, s.model AS session_model
                   FROM image_generation_messages m
                   JOIN image_generation_sessions s ON s.id=m.session_id
                   WHERE m.id=? AND m.session_id=?""",
                (source_message_id, source_session_id),
            ).fetchone()
            if message is None:
                raise NotFoundError("图片消息不存在")
            if message["role"] != "assistant" or not message["image_url"]:
                raise ValueError("该消息未生成图片")

            run = connection.execute(
                """SELECT metadata_json FROM image_runs
                   WHERE assistant_message_id=?""",
                (source_message_id,),
            ).fetchone()
            run_metadata = json.loads(run["metadata_json"] or "{}") if run else {}

            metadata = {
                "prompt": message["content"] or "",
                "image_prompt": message["image_prompt"] or "",
                "width": run_metadata.get("width"),
                "height": run_metadata.get("height"),
                "seed": run_metadata.get("seed"),
            }

            asset_id = str(uuid4())
            connection.execute(
                """INSERT INTO assets
                   (id,kind,source,source_session_id,source_message_id,title,
                    storage_url,provider,model,metadata_json,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    asset_id,
                    "image",
                    "image_generation",
                    source_session_id,
                    source_message_id,
                    title.strip() or "未命名素材",
                    message["image_url"],
                    message["session_provider"],
                    message["session_model"],
                    json.dumps(metadata, ensure_ascii=False),
                    timestamp,
                    timestamp,
                ),
            )
        return self.get_asset(asset_id)

    def list_assets(
        self,
        *,
        kind: str | None = "image",
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        params: list[Any] = []
        where_clause = ""
        if kind:
            where_clause = "WHERE kind=?"
            params.append(kind)
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(
                f"""SELECT id,kind,source,source_session_id,source_message_id,title,
                           storage_url,provider,model,metadata_json,created_at,updated_at
                    FROM assets {where_clause}
                    ORDER BY updated_at DESC LIMIT ?""",
                params,
            ).fetchall()
        results = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            results.append(item)
        return results

    def get_asset(self, asset_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT id,kind,source,source_session_id,source_message_id,title,
                          storage_url,provider,model,metadata_json,created_at,updated_at
                   FROM assets WHERE id=?""",
                (asset_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("素材不存在")
        item = dict(row)
        item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
        return item

    _PUBLISH_RECORD_COLUMNS = """p.id,p.article_id,p.version_id,p.theme_id,p.cover_asset_id,
                          p.author,p.digest,p.image_placements_json,p.status,p.media_id,
                          p.error_code,p.error_message,p.content_snapshot,p.created_at,
                          a.title AS article_title"""

    @staticmethod
    def _publish_record(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["image_placements"] = json.loads(item.pop("image_placements_json") or "[]")
        return item

    def create_publish_record(
        self,
        *,
        article_id: str,
        version_id: str | None,
        theme_id: str,
        cover_asset_id: str | None,
        author: str | None,
        digest: str | None,
        image_placements: list[dict[str, Any]],
        status: str,
        content_snapshot: str,
        media_id: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        record_id = str(uuid4())
        with self.transaction() as connection:
            article = connection.execute(
                "SELECT id FROM articles WHERE id=?", (article_id,)
            ).fetchone()
            if article is None:
                raise NotFoundError("文章不存在")
            connection.execute(
                """INSERT INTO publish_records
                   (id,article_id,version_id,theme_id,cover_asset_id,author,digest,
                    image_placements_json,status,media_id,error_code,error_message,
                    content_snapshot,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    record_id,
                    article_id,
                    version_id,
                    theme_id,
                    cover_asset_id,
                    author,
                    digest,
                    json.dumps(image_placements, ensure_ascii=False),
                    status,
                    media_id,
                    error_code,
                    error_message,
                    content_snapshot,
                    now_iso(),
                ),
            )
        return self.get_publish_record(record_id)

    def list_publish_records(
        self, article_id: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        params: list[Any] = []
        where_clause = ""
        if article_id:
            where_clause = "WHERE p.article_id=?"
            params.append(article_id)
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(
                f"""SELECT {self._PUBLISH_RECORD_COLUMNS}
                    FROM publish_records p LEFT JOIN articles a ON a.id=p.article_id
                    {where_clause}
                    ORDER BY p.created_at DESC LIMIT ?""",
                params,
            ).fetchall()
        return [self._publish_record(row) for row in rows]

    def get_publish_record(self, record_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                f"""SELECT {self._PUBLISH_RECORD_COLUMNS}
                    FROM publish_records p LEFT JOIN articles a ON a.id=p.article_id
                    WHERE p.id=?""",
                (record_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("发布记录不存在")
        return self._publish_record(row)
