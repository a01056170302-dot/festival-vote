"""D1-compatible SQL call adapter for offline API tests; not a workerd emulator."""
import sys,json,sqlite3
payload=json.load(open(sys.argv[1]))
conn=sqlite3.connect(payload['db']);conn.row_factory=sqlite3.Row
conn.execute('PRAGMA foreign_keys=ON')
results=[]
try:
    with conn:
        for stmt in payload['statements']:
            before=conn.total_changes
            cur=conn.execute(stmt['sql'],stmt.get('args',[]))
            rows=[dict(r) for r in cur.fetchall()]
            results.append({'results':rows,'success':True,'meta':{'changes':conn.total_changes-before}})
    print(json.dumps(results))
finally:conn.close()
