import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('importer', Path(__file__).parents[1]/'scripts/import-benchdock.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.release = self.base/'release'
        self.release.mkdir()
        self.row = {'schema':'benchdock.catalog/v1','task_id':'fixture-1','title':'Synthetic fixture','prompt':'Read the input.',
                    'distribution':'bundled','inputs':[{'path':'datasets/sample/input/data.txt','destination':'input/data.txt','bytes':5,'sha256':importer.sha(b'input')}],
                    'license_files':['licenses/demo.txt']}
        self.task = 'datasets/sample/task.json'
        for name, value in {'datasets/sample/input/data.txt':b'input','licenses/demo.txt':b'demo','LICENSE':b'new material','NOTICE.md':b'notice'}.items():
            p=self.release/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(value)
        self.profile = {'schema':'evaldock.benchdock-profile/v1','repo_id':'EvalDock/BenchDock','revision':'a'*40,'tasks':[{'task_id':'fixture-1','task_path':self.task,
            'capabilityLabels':['artifact-delivery'],'environment':{'platform':'portable','timeoutSeconds':30,'allowedEdits':['work/**','output/**'],'dependencies':[]}}]}
        self.profile_path=self.base/'profile.json'
        self.refresh()

    def refresh(self):
        (self.release/self.task).write_text(json.dumps(self.row))
        (self.release/'catalog.jsonl').write_text(json.dumps(self.row)+'\n')
        entries=[{'path':p.relative_to(self.release).as_posix(),'bytes':p.stat().st_size,'sha256':importer.sha(p.read_bytes())}
                 for p in sorted(self.release.rglob('*')) if p.is_file() and p.name!='FILES.jsonl']
        (self.release/'FILES.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in entries))
        self.profile['manifest_sha256']=importer.sha((self.release/'FILES.jsonl').read_bytes())
        self.profile_path.write_text(json.dumps(self.profile))

    def run_import(self):
        return importer.import_release(self.release,self.profile_path,self.base/'imported')

    def test_import_preserves_inputs_provenance_and_excludes_references(self):
        result=self.run_import()
        q=json.loads(next((self.base/'imported').glob('benchdock-public/*/question.json')).read_text())
        self.assertEqual(q['grading']['mode'],'unavailable')
        self.assertEqual(q['benchdock']['revision'],'a'*40)
        self.assertEqual(result['imported_tasks'],['fixture-1'])
        self.assertFalse(any(p.name=='private' for p in (self.base/'imported').rglob('*')))
        with self.assertRaisesRegex(ValueError,'already exists'):self.run_import()

    def test_source_only_not_executable(self):
        self.row.update(distribution='source_reference',prompt=None,inputs=[]);self.refresh()
        with self.assertRaisesRegex(ValueError,'Source-reference'):self.run_import()
        self.assertFalse((self.base/'imported').exists())

    def test_manifest_pin_and_input_integrity(self):
        (self.release/'datasets/sample/input/data.txt').write_text('altered')
        with self.assertRaisesRegex(ValueError,'checksum'):self.run_import()
        (self.release/'FILES.jsonl').write_text('')
        with self.assertRaisesRegex(ValueError,'manifest'):self.run_import()

    def test_path_traversal_and_symlinks(self):
        self.row['inputs'][0]['destination']='input/../../escape';self.refresh()
        with self.assertRaisesRegex(ValueError,'destination'):self.run_import()
        self.row['inputs'][0]['destination']='input/data.txt';self.refresh()
        p=self.release/'datasets/sample/input/data.txt';p.unlink();p.symlink_to(self.release/'LICENSE')
        with self.assertRaisesRegex(ValueError,'symlinks'):self.run_import()

    def test_duplicate_input_and_catalog_task_mismatch(self):
        self.row['inputs']*=2;self.refresh()
        with self.assertRaisesRegex(ValueError,'Duplicate input'):self.run_import()
        self.row['inputs']=self.row['inputs'][:1];self.refresh()
        record=json.loads((self.release/self.task).read_text());record['prompt']='different'
        (self.release/self.task).write_text(json.dumps(record))
        # Repin the manifest to isolate the task/catalog equality check.
        entries=[json.loads(x) for x in (self.release/'FILES.jsonl').read_text().splitlines()]
        b=(self.release/self.task).read_bytes()
        for e in entries:
            if e['path']==self.task:e.update(bytes=len(b),sha256=importer.sha(b))
        (self.release/'FILES.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in entries))
        self.profile['manifest_sha256']=importer.sha((self.release/'FILES.jsonl').read_bytes());self.profile_path.write_text(json.dumps(self.profile))
        with self.assertRaisesRegex(ValueError,'differs from catalog'):self.run_import()


if __name__=='__main__':unittest.main()
