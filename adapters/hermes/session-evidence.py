"""Read only the owned Hermes session's tool evidence; never select reasoning columns."""
import json, sqlite3, sys
from pathlib import Path
file = Path(sys.argv[1]).resolve()
connection = sqlite3.connect(file.as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
archive = sys.argv[2] == '--session-archive'
if archive:
    sessions = connection.execute("SELECT id, ended_at FROM sessions LIMIT 2").fetchall()
    if len(sessions) != 1 or sessions[0]['ended_at'] is None:
        raise RuntimeError('HERMES_SESSION_INCOMPLETE')
    session_id = sessions[0]['id']
else:
    session_id = sys.argv[2]
rows = connection.execute("SELECT role, tool_call_id, tool_calls, tool_name, CASE WHEN role = 'tool' THEN content ELSE NULL END AS content, timestamp FROM messages WHERE session_id = ? AND (tool_calls IS NOT NULL OR role = ?) ORDER BY id LIMIT 513", (session_id, 'tool')).fetchall()
if len(rows) > 512:
    raise RuntimeError('HERMES_EVIDENCE_LIMIT')
result = [dict(row) for row in rows]
if any(len(str(value)) > 65536 for row in result for value in row.values()):
    raise RuntimeError('HERMES_EVIDENCE_LIMIT')
if archive:
    final = connection.execute("SELECT content, finish_reason FROM messages WHERE session_id = ? AND role = 'assistant' AND tool_calls IS NULL ORDER BY id DESC LIMIT 1", (session_id,)).fetchone()
    if final is None or not final['content'] or final['finish_reason'] not in ('stop', 'end_turn'):
        raise RuntimeError('HERMES_SESSION_INCOMPLETE')
    result = {'sessionId': session_id, 'final': final['content'], 'rows': result}
output = json.dumps(result)
if len(output.encode()) > 1048576:
    raise RuntimeError('HERMES_EVIDENCE_LIMIT')
print(output)
