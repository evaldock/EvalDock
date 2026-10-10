
const args=process.argv.slice(2),action=args[0];
const summary=status=>JSON.stringify({schema:'evaldock.mvp.cli-summary/v1',status,runId:args[args.indexOf('--run-id')+1]});
if(action==='inspect'){
  process.stderr.write('progress token='+process.env.TEST_SECRET+'\n');
  const text=summary('COMPLETED');process.stdout.write(text.slice(0,20));
  setTimeout(()=>{process.stdout.write(text.slice(20)+'\n');},30);
}else if(action==='plan'){
  process.stdout.write(summary('FAILED')+'\n');process.exitCode=4;
}else{
  process.on('SIGINT',()=>{process.stdout.write(summary('CANCELLED')+'\n');clearInterval(timer);process.exitCode=130;});
  process.stderr.write('READY_FOR_CANCEL\n');
  const timer=setInterval(()=>{},1000);
}
