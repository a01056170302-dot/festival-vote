import unittest,sqlite3,tempfile,pathlib,concurrent.futures,time,json,statistics
SCHEMA=pathlib.Path(__file__).resolve().parents[1]/'migrations/0001_initial.sql'
class DatabaseTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=self.temp.name+'/test.db';self.c=sqlite3.connect(self.path);self.c.executescript(SCHEMA.read_text())
  self.c.executemany('INSERT INTO participants(id,display_name,mask_name) VALUES(?,?,?)',[(s,s,s) for s in ['a','b','c','d']])
  self.create('m1','a','b');self.c.execute("UPDATE event_state SET current_match_id='m1'");self.c.execute("UPDATE matches SET status='OPEN' WHERE id='m1'");self.c.commit()
 def tearDown(self):self.c.close();self.temp.cleanup()
 def create(self,m,a,b):self.c.execute('INSERT INTO matches(id,round_label,match_title,participant_a_id,participant_b_id,participant_a_name_snapshot,participant_b_name_snapshot,participant_a_mask_snapshot,participant_b_mask_snapshot) VALUES(?,?,?,?,?,?,?,?,?)',(m,'결승',m,a,b,a,b,a,b))
 def insert(self,i,match='m1',voter=None):
  c=sqlite3.connect(self.path,timeout=60);c.execute('PRAGMA foreign_keys=ON');t=time.perf_counter()
  try:
   c.execute('INSERT INTO votes(id,match_id,voter_hash,selected_participant_id,request_id) SELECT ?,m.id,?,?,? FROM matches m JOIN event_state e ON e.current_match_id=m.id WHERE m.id=? AND m.status=\'OPEN\' AND ? IN(m.participant_a_id,m.participant_b_id) ON CONFLICT DO NOTHING',(str(i),voter or str(i),'a','req'+str(i),match,'a'));c.commit()
   return (time.perf_counter()-t)*1000
  finally:c.close()
 def count(self):return self.c.execute('SELECT COUNT(*) FROM votes').fetchone()[0]
 def test_700_concentrated_votes(self):
  with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:lat=list(pool.map(self.insert,range(700)))
  self.assertEqual(self.count(),700);self.assertEqual(self.c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
  print('\nSQLITE 700 votes measured:',json.dumps({'votes':self.count(),'sql_latency_p95_ms':round(sorted(lat)[int(.95*len(lat))],2),'max_ms':round(max(lat),2),'concurrency':64}))
 def test_duplicate_parallel(self):
  with concurrent.futures.ThreadPoolExecutor(max_workers=32) as p:list(p.map(lambda i:self.insert(i,voter='same'),range(60)))
  self.assertEqual(self.count(),1)
 def test_close_race(self):
  with concurrent.futures.ThreadPoolExecutor(max_workers=32) as p:
   jobs=[p.submit(self.insert,i) for i in range(200)]
   self.c.execute("UPDATE matches SET status='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='m1'");self.c.commit()
   at_close=self.count()
   [f.result() for f in jobs]
  self.assertEqual(self.count(),at_close)
  self.insert('late');self.assertEqual(self.count(),at_close)
  self.assertEqual(self.c.execute('SELECT count(*) FROM votes v JOIN matches m ON v.match_id=m.id WHERE v.created_at>m.closed_at').fetchone()[0],0)
 def test_guards_and_preservation(self):
  self.insert(1)
  with self.assertRaises(sqlite3.IntegrityError):self.c.execute("UPDATE event_state SET current_match_id=NULL")
  self.c.execute("UPDATE matches SET status='CLOSED' WHERE id='m1'");self.c.execute("UPDATE matches SET status='OPEN' WHERE id='m1'");self.assertEqual(self.count(),1)
  self.c.execute("UPDATE matches SET status='CLOSED' WHERE id='m1'");self.c.execute("UPDATE matches SET status='PUBLISHED' WHERE id='m1'")
  with self.assertRaises(sqlite3.IntegrityError):self.c.execute("UPDATE matches SET status='OPEN' WHERE id='m1'")
  self.create('m2','c','d');self.c.execute("UPDATE event_state SET current_match_id='m2'");self.c.execute("UPDATE matches SET status='OPEN' WHERE id='m2'");self.c.commit();self.insert('late',match='m1');self.assertEqual(self.count(),1)
  with self.assertRaises(sqlite3.IntegrityError):self.c.execute("UPDATE votes SET selected_participant_id='b'")
  with self.assertRaises(sqlite3.IntegrityError):self.c.execute("DELETE FROM votes")
  with self.assertRaises(sqlite3.IntegrityError):self.c.execute("INSERT INTO votes VALUES('bad','m2','hash','a','badreq','now')")
if __name__=='__main__':unittest.main()
