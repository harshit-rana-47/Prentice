/* Private process guardian. Authenticate with the connector before starting the agent.
 * EOF on the owner channel (including connector SIGKILL) ends the contained process tree.
 * The Windows job disallows breakaway and kills its members when the guardian's handle closes.
 * POSIX descendants inherit a dedicated session/process group; deliberately escaping that group
 * is outside this mechanism's guarantee and must not be described as kernel job containment.
 */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
static HANDLE job;
static BOOL WINAPI stop(DWORD event) { if(job) TerminateJobObject(job,130); return TRUE; }
static void quote(wchar_t *out, const wchar_t *arg) {
  size_t n=wcslen(out); out[n++]=L'"';
  while(*arg) {
    unsigned slashes=0; while(*arg==L'\\') {slashes++; arg++;}
    if(*arg==L'"' || !*arg) slashes*=2;
    while(slashes--) out[n++]=L'\\';
    if(*arg==L'"') out[n++]=L'\\';
    if(*arg) out[n++]=*arg++;
  }
  out[n++]=L'"'; out[n]=0;
}
int wmain(int argc, wchar_t **argv) {
  wchar_t endpoint[256], token[128], command[32768], line[32768]=L"";
  if(!GetEnvironmentVariableW(L"PRENTICE_GUARD_ENDPOINT",endpoint,256) || !GetEnvironmentVariableW(L"PRENTICE_GUARD_TOKEN",token,128) || !GetEnvironmentVariableW(L"PRENTICE_GUARD_COMMAND",command,32768)) return 125;
  HANDLE owner=CreateFileW(endpoint,GENERIC_READ|GENERIC_WRITE,0,NULL,OPEN_EXISTING,0,NULL);
  if(owner==INVALID_HANDLE_VALUE) return 125;
  char nonce[128]; int len=WideCharToMultiByte(CP_UTF8,0,token,-1,nonce,126,NULL,NULL)-1;
  len += sprintf(nonce+len," %lu\n",(unsigned long)GetCurrentProcessId()); DWORD bytes; if(!WriteFile(owner,nonce,len,&bytes,NULL)) return 125;
  char ready; if(!ReadFile(owner,&ready,1,&bytes,NULL) || bytes!=1 || ready!='R') return 125;
  job=CreateJobObjectW(NULL,NULL); if(!job) return 125;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0}; limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) return 125;
  SetConsoleCtrlHandler(stop,TRUE);
  size_t required=wcslen(command)*2+4; for(int i=1;i<argc;i++) required+=wcslen(argv[i])*2+4; if(required>=32768) return 125;
  quote(line,command); for(int i=1;i<argc;i++) { wcscat(line,L" "); quote(line,argv[i]); }
  STARTUPINFOW startup={0}; startup.cb=sizeof(startup); startup.dwFlags=STARTF_USESTDHANDLES;
  startup.hStdInput=GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError=GetStdHandle(STD_ERROR_HANDLE);
  SetHandleInformation(startup.hStdInput,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT);
  SetHandleInformation(startup.hStdOutput,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT);
  SetHandleInformation(startup.hStdError,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT);
  PROCESS_INFORMATION child={0};
  /* Assignment happens before the process can execute or spawn descendants. */
  if(!CreateProcessW(command,line,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW,NULL,NULL,&startup,&child)) return 125;
  if(!AssignProcessToJobObject(job,child.hProcess)) { TerminateProcess(child.hProcess,125); return 125; }
  ResumeThread(child.hThread); CloseHandle(child.hThread);
  DWORD code=130;
  while(WaitForSingleObject(child.hProcess,50)==WAIT_TIMEOUT) {
    if(!PeekNamedPipe(owner,NULL,0,NULL,&bytes,NULL) || bytes) { TerminateJobObject(job,130); WaitForSingleObject(child.hProcess,5000); break; }
  }
  GetExitCodeProcess(child.hProcess,&code);
  TerminateJobObject(job,code); CloseHandle(job); CloseHandle(child.hProcess);
  WriteFile(owner,"D\n",2,&bytes,NULL); CloseHandle(owner);
  return (int)code;
}
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/select.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <time.h>
static volatile sig_atomic_t stopping=0;
static void stop(int signal) { stopping=1; }
static long milliseconds(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1000+t.tv_nsec/1000000; }
int main(int argc, char **argv) {
  const char *endpoint=getenv("PRENTICE_GUARD_ENDPOINT"), *token=getenv("PRENTICE_GUARD_TOKEN"), *command=getenv("PRENTICE_GUARD_COMMAND");
  if(!endpoint || !token || !command) return 125;
  int owner=socket(AF_UNIX,SOCK_STREAM,0); struct sockaddr_un address={0}; address.sun_family=AF_UNIX;
  if(strlen(endpoint)>=sizeof(address.sun_path)) return 125;
  strcpy(address.sun_path,endpoint);
  if(connect(owner,(struct sockaddr*)&address,sizeof(address))<0) return 125;
  char nonce[128]; int length=snprintf(nonce,sizeof(nonce),"%s %ld\n",token,(long)getpid());
  if(write(owner,nonce,length)!=length) return 125;
  char ready; if(read(owner,&ready,1)!=1 || ready!='R') return 125;
  signal(SIGINT,stop); signal(SIGTERM,stop); signal(SIGHUP,stop); signal(SIGPIPE,SIG_IGN);
  /* Agent waits on a launch gate until its session/group is established, closing the Stop race. */
  int gate[2]; if(pipe(gate)<0) return 125;
  pid_t child=fork();
  if(child<0) return 125;
  if(child==0) {
    close(gate[1]); close(owner);
    if(setsid()<0) _exit(125);
    char launch; if(read(gate[0],&launch,1)!=1) _exit(125); close(gate[0]);
    signal(SIGINT,SIG_DFL); signal(SIGTERM,SIG_DFL); signal(SIGHUP,SIG_DFL); signal(SIGPIPE,SIG_DFL);
    argv[0]=(char*)command; execvp(command,argv); _exit(127);
  }
  close(gate[0]);
  /* Wait until setsid has run before opening the gate. */
  while(getpgid(child)!=child) { int status; if(waitpid(child,&status,WNOHANG)==child) return 125; usleep(1000); }
  char group[64]; int groupLength=snprintf(group,sizeof(group),"G %ld\n",(long)child);
  char acknowledged;
  if(write(owner,group,groupLength)!=groupLength || read(owner,&acknowledged,1)!=1 || acknowledged!='A') stopping=1;
  if(!stopping) write(gate[1],"R",1); close(gate[1]);
  long stoppedAt=0; int status=0;
  for(;;) {
    if(waitpid(child,&status,WNOHANG)==child) break;
    fd_set set; FD_ZERO(&set); FD_SET(owner,&set); struct timeval timeout={0,50000};
    int available=select(owner+1,&set,NULL,NULL,&timeout);
    if(available>0) { char byte; read(owner,&byte,1); stopping=1; }
    if(stopping) {
      if(!stoppedAt) { stoppedAt=milliseconds(); kill(-child,SIGINT); }
      long elapsed=milliseconds()-stoppedAt;
      if(elapsed>=1000) kill(-child,SIGTERM);
      if(elapsed>=2000) kill(-child,SIGKILL);
    }
  }
  /* A completed top-level agent must not leave background descendants editing. */
  kill(-child,SIGKILL);
  write(owner,"D\n",2);
  close(owner);
  return stopping ? 130 : WIFEXITED(status) ? WEXITSTATUS(status) : 128+WTERMSIG(status);
}
#endif
