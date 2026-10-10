"""Read only the owned Hermes session's tool evidence; never select reasoning columns."""
import json, sqlite3, sys
from pathlib import Path
file = Path(sys.argv[1]).resolve()
connection = sqlite3.connect(file.as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
rows = connection.execute("SELECT role, tool_call_id, tool_calls, tool_name, CASE WHEN role = 'tool' THEN content ELSE NULL END AS content, timestamp FROM messages WHERE session_id = ? AND (tool_calls IS NOT NULL OR role = ?) ORDER BY id LIMIT 513", (sys.argv[2], 'tool')).fetchall()
if len(rows) > 512:
    raise RuntimeError('HERMES_EVIDENCE_LIMIT')
result = [dict(row) for row in rows]
if any(len(str(value)) > 65536 for row in result for value in row.values()):
    raise RuntimeError('HERMES_EVIDENCE_LIMIT')
output = json.dumps(result)
if len(output.encode()) > 1048576:
    raise RuntimeError('HERMES_EVIDENCE_LIMIT')
print(output)
