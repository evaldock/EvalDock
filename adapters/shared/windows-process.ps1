# Private pipe protocol: one JSON launch request, then cancellation or stdin EOF.
# Target output is framed as base64, so it cannot forge supervisor receipts.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  # The host can replace Console.In; bind directly to inherited stdin instead.
  # Keep this reader for cancellation too: it may already buffer the next line.
  $control = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
  [Console]::WriteLine('{"type":"phase","name":"READ_REQUEST"}')
  [Console]::Out.Flush()
  $requestLine = $control.ReadLine()
  [Console]::WriteLine('{"type":"phase","name":"REQUEST_READ"}')
  [Console]::Out.Flush()
  $request = ConvertFrom-Json -InputObject $requestLine
  [Console]::WriteLine('{"type":"phase","name":"COMPILE"}')
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class EvalDockOwnedProcess {
  [StructLayout(LayoutKind.Sequential)] struct Security { public int size; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int size; public string reserved, desktop, title;
    public uint x,y,width,height,charsX,charsY,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long userTime,kernelTime,periodUser,periodKernel;
    public uint faults,total,active,terminated;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security attributes,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint sharing,ref Security attributes,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static readonly object outputLock = new object();
  static string phase="ENTER";
  static void Phase(string name) { phase=name; Emit("{\"type\":\"phase\",\"name\":\""+name+"\"}"); }
  static void Emit(string json) { lock(outputLock) { Console.WriteLine(json); Console.Out.Flush(); } }
  static void Check(bool success) { if(!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static void Close(ref IntPtr handle) { if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle); handle=IntPtr.Zero; }
  // Windows CRT quoting; no shell interpolation, including empty/trailing-backslash arguments.
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      result.Append('\\',c=='"'?slashes*2+1:slashes); result.Append(c); slashes=0;
    }
    return result.Append('\\',slashes*2).Append('"').ToString();
  }
  static string Executable(string command,string cwd,string searchPath) {
    string[] candidates=Path.IsPathRooted(command)||command.Contains("\\")||command.Contains("/")
      ? new[]{Path.GetFullPath(Path.Combine(cwd,command))}
      : new[]{cwd}.Concat((searchPath??"").Split(';').Select(p=>p.Trim('"')).Where(p=>p.Length>0)).Select(p=>Path.Combine(p,command)).ToArray();
    foreach(string candidate in candidates) {
      string file=Path.HasExtension(candidate)?candidate:candidate+".exe";
      if(File.Exists(file)) return Path.GetFullPath(file);
    }
    throw new FileNotFoundException();
  }
  static Task Pump(IntPtr handle,bool stdout,Action<int> count) {
    return Task.Run(()=>{
      using(var stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,8192,false)) {
        var bytes=new byte[8192]; int size;
        while((size=stream.Read(bytes,0,bytes.Length))>0) {
          if(stdout) Emit("{\"type\":\"stdout\",\"data\":\""+Convert.ToBase64String(bytes,0,size)+"\"}");
          else count(size); // Raw stderr never enters the supervisor protocol.
        }
      }
    });
  }
  public static int Run(string command,string[] args,string cwd,string environment,string searchPath,TextReader control) {
    IntPtr job=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,env=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero;
    ProcessInfo child=new ProcessInfo(); bool assigned=false,attributesReady=false,stopped=false,failed=false,exitReported=false;
    long stderrBytes=0; Task outPump=null,errPump=null;
    // A cancelled request queued during PowerShell compilation must not start a target.
    var cancel=Task.Run(()=>control.ReadLine());
    try {
      Phase("CREATE_JOB");
      if(cancel.Wait(10)) { Emit("{\"type\":\"cleanup\",\"stopped\":true,\"stderrBytes\":0}"); return 0; }
      job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero); Check(job!=IntPtr.Zero);
      var limits=new ExtendedLimit(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
      var security=new Security { size=Marshal.SizeOf(typeof(Security)),inherit=1 };
      Check(CreatePipe(out outRead,out outWrite,ref security,0)); Check(SetHandleInformation(outRead,1,0));
      Check(CreatePipe(out errRead,out errWrite,ref security,0)); Check(SetHandleInformation(errRead,1,0));
      input=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1));
      IntPtr bytes=IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
      attributes=Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(attributes,1,0,ref bytes)); attributesReady=true;
      handles=Marshal.AllocHGlobal(3*IntPtr.Size);
      Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,2*IntPtr.Size,errWrite);
      // Only target stdio is inherited; the job handle and supervisor control pipe are private.
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var startup=new StartupEx(); startup.startup.size=Marshal.SizeOf(startup); startup.startup.flags=0x100;
      startup.startup.input=input; startup.startup.output=outWrite; startup.startup.error=errWrite; startup.attributes=attributes;
      string executable=Executable(command,cwd,searchPath);
      var argv=new StringBuilder(Quote(executable)); foreach(string arg in args) argv.Append(' ').Append(Quote(arg));
      env=Marshal.StringToHGlobalUni(environment);
      Phase("CREATE_TARGET");
      Check(CreateProcessW(executable,argv,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref startup,out child));
      Check(AssignProcessToJobObject(job,child.process)); assigned=true;
      Close(ref outWrite); Close(ref errWrite); Close(ref input);
      outPump=Pump(outRead,true,n=>{}); outRead=IntPtr.Zero;
      errPump=Pump(errRead,false,n=>Interlocked.Add(ref stderrBytes,n)); errRead=IntPtr.Zero;
      Phase("ASSIGNED");
      if(!cancel.IsCompleted) {
        string started=DateTime.UtcNow.ToString("o");
        Check(ResumeThread(child.thread)!=UInt32.MaxValue);
        Emit("{\"type\":\"started\",\"pid\":"+child.pid+",\"at\":\""+started+"\"}");
        while(!cancel.IsCompleted) { uint state=WaitForSingleObject(child.process,20); if(state==0) break; Check(state==258); }
      }
      uint exitCode;
      if(WaitForSingleObject(child.process,0)==0 && GetExitCodeProcess(child.process,out exitCode)) {
        Emit("{\"type\":\"exit\",\"code\":"+exitCode+",\"at\":\""+DateTime.UtcNow.ToString("o")+"\"}");
        exitReported=true;
      }
    } catch(Exception error) {
      failed=true;
      var native=error as System.ComponentModel.Win32Exception;
      Emit("{\"type\":\"failure\",\"phase\":\""+phase+"\",\"code\":"+(native==null?error.HResult:native.NativeErrorCode)+"}");
    }
    finally {
      // On assignment failure the target is still suspended and cannot have descendants.
      if(child.process!=IntPtr.Zero && !assigned) {
        stopped=TerminateProcess(child.process,1) && WaitForSingleObject(child.process,2000)==0;
      } else if(job!=IntPtr.Zero) {
        if(TerminateJobObject(job,1)) {
          for(int i=0;i<100;i++) {
            Accounting state;
            if(!QueryInformationJobObject(job,1,out state,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) break;
            if(state.active==0) { stopped=true; break; }
            Thread.Sleep(20);
          }
        }
      } else stopped=child.process==IntPtr.Zero;
      Close(ref job); // Fail-safe on every path, also enforced by OS on supervisor death.
      uint finalCode;
      if(!exitReported && child.process!=IntPtr.Zero && WaitForSingleObject(child.process,0)==0 && GetExitCodeProcess(child.process,out finalCode))
        Emit("{\"type\":\"exit\",\"code\":"+finalCode+",\"at\":\""+DateTime.UtcNow.ToString("o")+"\"}");
      Close(ref child.thread); Close(ref child.process);
      Close(ref outWrite); Close(ref errWrite); Close(ref input); Close(ref outRead); Close(ref errRead);
      try { if(outPump!=null && !Task.WaitAll(new[]{outPump,errPump},2000)) failed=true; } catch { failed=true; }
      if(attributesReady) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
    Emit("{\"type\":\"cleanup\",\"stopped\":"+(stopped?"true":"false")+",\"stderrBytes\":"+stderrBytes+",\"failed\":"+(failed?"true":"false")+"}");
    return failed?1:0;
  }
}
'@
  $environment = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($request.environment))
  [Console]::WriteLine('{"type":"phase","name":"RUN"}')
  exit [EvalDockOwnedProcess]::Run($request.command,[string[]]$request.args,$request.cwd,$environment,$request.searchPath,$control)
} catch {
  # No exception text: errors may contain arguments, target paths or credentials.
  [Console]::WriteLine('{"type":"failure","phase":"POWERSHELL","code":' + $_.Exception.HResult + '}')
  exit 1
}
