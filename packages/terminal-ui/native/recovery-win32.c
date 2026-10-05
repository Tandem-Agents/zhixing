#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
#include <io.h>

/* Foreground Windows recovery companion. The sole baseline stays in memory.
   This process reads only its private control pipe and never supervises or
   launches another process. Restoration requires the owning supervisor. */
typedef struct { DWORD mode[3],cp,outcp; CONSOLE_CURSOR_INFO cursor; CONSOLE_SCREEN_BUFFER_INFO buffer; } Baseline;
static HANDLE controlEvent,commandEvent,consumedEvent,outEvent,outAck,reader,writer;
static HANDLE controlPipe = INVALID_HANDLE_VALUE;
static HANDLE readIoEvent, writeIoEvent;
static volatile LONG controls=0;
static char commandSlot[256],outputSlot[8192],nonce[48]="aux";
static DWORD outputLength; static BOOL outputOK=TRUE,outputBroken=FALSE,asyncOutput=FALSE;
static unsigned long seq=0;
static HANDLE stdh(int i){return GetStdHandle(i==0?STD_INPUT_HANDLE:i==1?STD_OUTPUT_HANDLE:STD_ERROR_HANDLE);}
static BOOL modesRegistered=FALSE,modesPermitted=FALSE,finalizing=FALSE;static DWORD originalModes=0;
/* 0 untouched, 1 enter attempted, 2 entered, 3 leave attempted, 4 returned, 5 unknown/failed. */
static int bufferPhase=0;
static unsigned long long closeDeadline=0;
static BOOL newlineAttempted=FALSE;
static const unsigned int modeIds[9]={1000,1002,1003,1006,1004,2004,1049,25,1005};
static HANDLE extra(int fd){return controlPipe != INVALID_HANDLE_VALUE ? controlPipe : (HANDLE)_get_osfhandle(fd);}
static BOOL channel_io(BOOL writing,void *bytes,DWORD count,DWORD *transferred){
 if(controlPipe==INVALID_HANDLE_VALUE)return writing?WriteFile(extra(3),bytes,count,transferred,NULL):ReadFile(extra(4),bytes,count,transferred,NULL);
 OVERLAPPED io={0};io.hEvent=writing?writeIoEvent:readIoEvent;ResetEvent(io.hEvent);
 BOOL ok=writing?WriteFile(controlPipe,bytes,count,transferred,&io):ReadFile(controlPipe,bytes,count,transferred,&io);
 return ok||(GetLastError()==ERROR_IO_PENDING&&GetOverlappedResult(controlPipe,&io,transferred,TRUE));
}
static unsigned long long born(HANDLE h){FILETIME b,e,k,u;if(!GetProcessTimes(h,&b,&e,&k,&u))return 0;return ((unsigned long long)b.dwHighDateTime<<32)|b.dwLowDateTime;}
static unsigned long long utc(void){FILETIME f;GetSystemTimeAsFileTime(&f);return ((((unsigned long long)f.dwHighDateTime<<32)|f.dwLowDateTime)-116444736000000000ULL)/10000ULL;}
static BOOL WINAPI control(DWORD type){if(type==CTRL_C_EVENT||type==CTRL_BREAK_EVENT){InterlockedIncrement(&controls);if(controlEvent)SetEvent(controlEvent);return TRUE;}return FALSE;}
static DWORD WINAPI write_thread(void *unused){(void)unused;for(;;){WaitForSingleObject(outEvent,INFINITE);DWORD n=0;outputOK=channel_io(TRUE,outputSlot,outputLength,&n)&&n==outputLength;SetEvent(outAck);}return 0;}
static BOOL emit(const char *text){
 if(outputBroken)return FALSE;DWORD len=(DWORD)strlen(text),n=0;
 if(!asyncOutput){BOOL ok=channel_io(TRUE,(void *)text,len,&n)&&n==len;if(!ok)outputBroken=TRUE;return ok;}
 if(len>=sizeof outputSlot){outputBroken=TRUE;return FALSE;}
 memcpy(outputSlot,text,len);outputLength=len;SetEvent(outEvent);
 if(WaitForSingleObject(outAck,1000)!=WAIT_OBJECT_0){outputBroken=TRUE;if(controlPipe!=INVALID_HANDLE_VALUE)CancelIoEx(controlPipe,NULL);else CancelSynchronousIo(writer);return FALSE;}
 if(!outputOK)outputBroken=TRUE;return !outputBroken;
}
static BOOL event(const char *name,const char *fields){char b[8192];int n=snprintf(b,sizeof b,"{\"v\":1,\"instance\":\"%s\",\"seq\":%lu,\"utc\":%llu,\"tick\":%llu,\"pid\":%lu,\"born\":\"%llu\",\"event\":\"%s\"%s}\n",nonce,++seq,utc(),GetTickCount64(),GetCurrentProcessId(),born(GetCurrentProcess()),name,fields?fields:"");if(n<0||n>=(int)sizeof b)return FALSE;return emit(b);}
static int api(const char *name,BOOL ok){DWORD error=ok?0:GetLastError();char b[256];snprintf(b,sizeof b,",\"operation\":\"%s\",\"ok\":%s,\"error\":%lu",name,ok?"true":"false",error);event("api",b);return ok?0:1;}
static void state_json(char *buf,size_t cap){
 DWORD m[3]={0},errors[3]={0};CONSOLE_CURSOR_INFO ci={0};
 for(int i=0;i<3;i++)if(!GetConsoleMode(stdh(i),&m[i]))errors[i]=GetLastError();
 BOOL c=GetConsoleCursorInfo(stdh(1),&ci);DWORD ce=c?0:GetLastError();
 snprintf(buf,cap,"{\"input\":%lu,\"output\":%lu,\"errorOutput\":%lu,\"modeErrors\":[%lu,%lu,%lu],\"inputCP\":%u,\"outputCP\":%u,\"cursor\":[%lu,%d],\"cursorError\":%lu}",m[0],m[1],m[2],errors[0],errors[1],errors[2],GetConsoleCP(),GetConsoleOutputCP(),ci.dwSize,ci.bVisible,ce);
}
static void state_event(const char *name){char state[4096],fields[4200];state_json(state,sizeof state);snprintf(fields,sizeof fields,",\"state\":%s",state);event(name,fields);}
static DWORD WINAPI read_thread(void *unused){
 (void)unused;for(;;){char line[256];DWORD at=0,n=0;BOOL eof=FALSE,overflow=FALSE;
  for(;;){char c;if(!channel_io(FALSE,&c,1,&n)||!n){eof=TRUE;break;}if(c=='\n')break;if(at<sizeof line-1)line[at++]=c;else overflow=TRUE;}
  line[at]=0;strcpy(commandSlot,eof?"channel-eof":overflow?"protocol-error":line);SetEvent(commandEvent);
  if(eof)return 0;WaitForSingleObject(consumedEvent,INFINITE);
 }return 0;
}
/* Control notifications are coalesced by an auto-reset event and one counter.
   Command queue capacity is one fixed 256-byte slot, protected by events. */
static int next_command(char *action,DWORD timeout){
 ULONGLONG end=timeout==INFINITE?0:GetTickCount64()+timeout;HANDLE handles[2]={controlEvent,commandEvent};
 for(;;){DWORD left=timeout==INFINITE?INFINITE:(GetTickCount64()>=end?0:(DWORD)(end-GetTickCount64()));DWORD w=WaitForMultipleObjects(2,handles,FALSE,left);
  if(w==WAIT_TIMEOUT)return 0;if(w==WAIT_OBJECT_0){char f[80];snprintf(f,sizeof f,",\"count\":%ld",controls);event("control",f);continue;}
  if(w!=WAIT_OBJECT_0+1)return -1;char local[256];strcpy(local,commandSlot);SetEvent(consumedEvent);
  if(!strcmp(local,"channel-eof"))return -2;
  unsigned int v=0;char token[48],extraText[2];int n=sscanf(local,"%u %47s %47s %1s",&v,token,action,extraText);
  if(n!=3||v!=1||strcmp(token,nonce)){event("protocol-error",NULL);continue;}return 1;
 }
}
static int capture(Baseline *b){memset(b,0,sizeof *b);int errors=0;
 for(int i=0;i<3;i++)errors+=api(i==0?"get-input":i==1?"get-output":"get-error-output",GetConsoleMode(stdh(i),&b->mode[i]));
 errors+=api("get-cursor",GetConsoleCursorInfo(stdh(1),&b->cursor));errors+=api("get-buffer",GetConsoleScreenBufferInfo(stdh(1),&b->buffer));
 b->cp=GetConsoleCP();errors+=api("get-input-cp",b->cp!=0);b->outcp=GetConsoleOutputCP();errors+=api("get-output-cp",b->outcp!=0);return errors;
}
static int write_effect(const char *operation,const char *sequence){
 HANDLE active=CreateFileW(L"CONOUT$",GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,0,NULL);
 if(active==INVALID_HANDLE_VALUE){api("effect-open-active",FALSE);return 1;}
 DWORD mode=0;if(!GetConsoleMode(active,&mode)){api("effect-get-mode",FALSE);CloseHandle(active);return 1;}
 if(!(mode&ENABLE_VIRTUAL_TERMINAL_PROCESSING)&&!SetConsoleMode(active,mode|ENABLE_PROCESSED_OUTPUT|ENABLE_VIRTUAL_TERMINAL_PROCESSING)){api("effect-enable-vt",FALSE);CloseHandle(active);return 1;}
 DWORD wanted=(DWORD)strlen(sequence),written=0;BOOL ok=WriteFile(active,sequence,wanted,&written,NULL);DWORD error=ok?0:GetLastError();
 char f[300];snprintf(f,sizeof f,",\"operation\":\"%s\",\"wanted\":%lu,\"written\":%lu,\"ok\":%s,\"error\":%lu",operation,wanted,written,ok?"true":"false",error);
 /* Authoritative effect phase is updated before any observation/ack. */
 BOOL complete=ok&&written==wanted;
 if(!strcmp(operation,"enter"))bufferPhase=complete?2:5;
 if(!strcmp(operation,"leave"))bufferPhase=complete?4:5;
 CloseHandle(active);event("effect-write",f);return complete?0:1;
}
static int activate_buffer(void){
 if(finalizing||!modesRegistered||bufferPhase!=0||(originalModes&(1u<<6))){event("activation-denied",NULL);return 1;}
 bufferPhase=1;int errors=write_effect("enter","\x1b[?1049h");if(errors)bufferPhase=5;
 if(!errors)event("entered",NULL);else event("activation-failed",NULL);return errors;
}
static int restore_modes(void){
 int errors=0;
 if(bufferPhase==2){bufferPhase=3;errors+=write_effect("leave","\x1b[?1049l");if(errors)bufferPhase=5;}
 else if(bufferPhase!=0&&bufferPhase!=4)errors++;
 if(modesPermitted){
  char sequence[256];int at=snprintf(sequence,sizeof sequence,"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l");
  for(int i=0;i<3;i++)if(originalModes&(1u<<i))at+=snprintf(sequence+at,sizeof sequence-at,"\x1b[?%uh",modeIds[i]);
  for(int i=0;i<9;i++)if(i==3||i==8){if(originalModes&(1u<<i))at+=snprintf(sequence+at,sizeof sequence-at,"\x1b[?%uh",modeIds[i]);}
  for(int i=4;i<8;i++)if(i!=6)at+=snprintf(sequence+at,sizeof sequence-at,"\x1b[?%u%c",modeIds[i],(originalModes&(1u<<i))?'h':'l');
  errors+=write_effect("restore-permitted-modes",sequence);
 }
 char f[180];snprintf(f,sizeof f,",\"phase\":%d,\"modesRegistered\":%s,\"modesPermitted\":%s",bufferPhase,modesRegistered?"true":"false",modesPermitted?"true":"false");event("buffer-outcome",f);return errors;
}
/* Only U+0020 with the known black background and no presentation flags is
   confirmed blank. Foreground colour has no ink on that space. Unknown
   characters/attributes count as occupied; clipped reads never count as blank. */
static BOOL blank_cell(CHAR_INFO c){return c.Char.UnicodeChar==L' '&&(c.Attributes&0xFFF0)==0;}
static BOOL within_close(void){return closeDeadline&&utc()+100<closeDeadline;}
static BOOL same_size(CONSOLE_SCREEN_BUFFER_INFO a,CONSOLE_SCREEN_BUFFER_INFO b){return a.dwSize.X==b.dwSize.X&&a.dwSize.Y==b.dwSize.Y;}
static BOOL scan_tail(HANDLE h,CONSOLE_SCREEN_BUFFER_INFO *info,int *tail){
 CHAR_INFO block[256];*tail=-1;
 if(!within_close()||!GetConsoleScreenBufferInfo(h,info)||info->dwSize.X<=0||info->dwSize.Y<=0)return FALSE;
 for(int y=0;y<info->dwSize.Y;y++)for(int x=0;x<info->dwSize.X;x+=256){
  if(!within_close())return FALSE;
  SHORT n=(SHORT)(info->dwSize.X-x>256?256:info->dwSize.X-x);
  SMALL_RECT requested={(SHORT)x,(SHORT)y,(SHORT)(x+n-1),(SHORT)y},actual=requested;
  if(!ReadConsoleOutputW(h,block,(COORD){n,1},(COORD){0,0},&actual)||memcmp(&actual,&requested,sizeof actual))return FALSE;
  for(int i=0;i<n;i++)if(!blank_cell(block[i]))*tail=y;
 }
 CONSOLE_SCREEN_BUFFER_INFO after;
 return GetConsoleScreenBufferInfo(h,&after)&&same_size(*info,after);
}
static int safe_handoff(void){
 if(bufferPhase==0){event("handoff-not-entered",NULL);return 0;}
 if(bufferPhase!=4||!within_close()){event("handoff-unconfirmed",",\"reason\":\"phase-or-deadline\"");return 1;}
 HANDLE h=CreateFileW(L"CONOUT$",GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,0,NULL);
 if(h==INVALID_HANDLE_VALUE){api("handoff-open",FALSE);return 1;}
 BOOL confirmed=FALSE;int attempts=0;
 while(within_close()&&attempts++<8){
  CONSOLE_SCREEN_BUFFER_INFO before,after;int tail=-1,verifiedTail=-1;
  if(!scan_tail(h,&before,&tail))continue;
  int y=before.dwCursorPosition.Y>tail+1?before.dwCursorPosition.Y:tail+1;
  char f[256];snprintf(f,sizeof f,",\"attempt\":%d,\"size\":[%d,%d],\"tail\":%d,\"cursor\":[%d,%d],\"targetY\":%d,\"newlineAttempted\":%s,\"deadline\":%llu",attempts,before.dwSize.X,before.dwSize.Y,tail,before.dwCursorPosition.X,before.dwCursorPosition.Y,y,newlineAttempted?"true":"false",closeDeadline);event("handoff-scan",f);
  if(!within_close())break;
  if(y<before.dwSize.Y){
   if(before.dwCursorPosition.X!=0||before.dwCursorPosition.Y!=y){
    if(api("handoff-position",SetConsoleCursorPosition(h,(COORD){0,(SHORT)y})))continue;
   }
  }else{
   if(newlineAttempted)break;
   if(api("handoff-bottom-position",SetConsoleCursorPosition(h,(COORD){0,(SHORT)(before.dwSize.Y-1)})))continue;
   DWORD mode=0;if(!GetConsoleMode(h,&mode)){api("handoff-get-output-mode",FALSE);break;}
   BOOL set=SetConsoleMode(h,(mode|ENABLE_PROCESSED_OUTPUT)&~ENABLE_VIRTUAL_TERMINAL_PROCESSING);
   api("handoff-temporary-output-mode",set);
   BOOL wrote=FALSE;DWORD count=0,error=0;
   if(set&&within_close()){
    newlineAttempted=TRUE; /* before even a partial/failed side effect */
    wrote=WriteConsoleW(h,L"\r\n",2,&count,NULL);error=wrote?0:GetLastError();
    snprintf(f,sizeof f,",\"wanted\":2,\"written\":%lu,\"ok\":%s,\"error\":%lu",count,wrote?"true":"false",error);event("handoff-newline",f);
   }
   BOOL restored=SetConsoleMode(h,mode);api("handoff-restore-output-mode",restored);
   if(!set||!wrote||count!=2||!restored)break;
  }
  /* A fresh full reduction checks content as well as dimensions. Equal sizes
     alone do not establish that the chosen row is still beyond the tail. */
  if(!scan_tail(h,&after,&verifiedTail))continue;
  if(!same_size(before,after))continue;
  if(after.dwCursorPosition.X!=0||after.dwCursorPosition.Y<=verifiedTail)continue;
  snprintf(f,sizeof f,",\"tail\":%d,\"position\":[%d,%d],\"size\":[%d,%d],\"newlineAttempted\":%s",verifiedTail,after.dwCursorPosition.X,after.dwCursorPosition.Y,after.dwSize.X,after.dwSize.Y,newlineAttempted?"true":"false");
  event("handoff-confirmed",f);confirmed=TRUE;break;
 }
 CloseHandle(h);if(!confirmed)event("handoff-unconfirmed",",\"reason\":\"read-position-or-budget\"");return confirmed?0:1;
}
static int restore(Baseline *b){
 int errors=0;finalizing=TRUE;state_event("restore-start");
 errors+=restore_modes();errors+=safe_handoff();
 errors+=api("set-input-cp",SetConsoleCP(b->cp));
 errors+=api("set-output-cp",SetConsoleOutputCP(b->outcp));
 CONSOLE_CURSOR_INFO beforeCursor={0};BOOL cursorRead=GetConsoleCursorInfo(stdh(1),&beforeCursor);errors+=api("current-cursor",cursorRead);
 if(cursorRead&&(beforeCursor.dwSize!=b->cursor.dwSize||beforeCursor.bVisible!=b->cursor.bVisible))errors+=api("set-cursor",SetConsoleCursorInfo(stdh(1),&b->cursor));
 errors+=api("set-output",SetConsoleMode(stdh(1),b->mode[1]));errors+=api("set-error-output",SetConsoleMode(stdh(2),b->mode[2]));errors+=api("set-input",SetConsoleMode(stdh(0),b->mode[0]));
 DWORD m[3]={0};for(int i=0;i<3;i++){BOOL ok=GetConsoleMode(stdh(i),&m[i]);errors+=api(i==0?"readback-input":i==1?"readback-output":"readback-error-output",ok);if(ok&&m[i]!=b->mode[i])errors++;}
 CONSOLE_CURSOR_INFO ci={0};BOOL ok=GetConsoleCursorInfo(stdh(1),&ci);errors+=api("readback-cursor",ok);if(ok&&(ci.dwSize!=b->cursor.dwSize||ci.bVisible!=b->cursor.bVisible))errors++;
 if(GetConsoleCP()!=b->cp||GetConsoleOutputCP()!=b->outcp)errors++;
 state_event("restored");char fields[100];snprintf(fields,sizeof fields,",\"errors\":%d,\"controls\":%ld",errors,controls);event("result",fields);
 /* Result precedes actual exit; S and observer must distinguish both. */
 event("exit-intent",fields);return errors||outputBroken?69:0;
}
int wmain(int argc,wchar_t **argv){
 if(argc!=3||wcscmp(argv[1],L"resident")||wcslen(argv[2])!=36)return 64;
 for(int i=0;i<36;i++)if(!((argv[2][i]>=L'0'&&argv[2][i]<=L'9')||(argv[2][i]>=L'a'&&argv[2][i]<=L'f')||argv[2][i]==L'-'))return 64;
 {
  wchar_t endpoint[128]; DWORD endpointLength = GetEnvironmentVariableW(L"ZHIXING_TERMINAL_PIPE", endpoint, 128);
  if(endpointLength){
   if(endpointLength>=128||wcsncmp(endpoint,L"\\\\.\\pipe\\zhixing-terminal-",26))return 64;
   controlPipe=CreateFileW(endpoint,GENERIC_READ|GENERIC_WRITE,0,NULL,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,NULL);
   if(controlPipe==INVALID_HANDLE_VALUE)return 73;
  }
  if(!WideCharToMultiByte(CP_UTF8,0,argv[2],-1,nonce,sizeof nonce,NULL,NULL))return 64;
  controlEvent=CreateEventW(NULL,FALSE,FALSE,NULL);commandEvent=CreateEventW(NULL,FALSE,FALSE,NULL);consumedEvent=CreateEventW(NULL,FALSE,FALSE,NULL);outEvent=CreateEventW(NULL,FALSE,FALSE,NULL);outAck=CreateEventW(NULL,FALSE,FALSE,NULL);
  readIoEvent=CreateEventW(NULL,TRUE,FALSE,NULL);writeIoEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if(!controlEvent||!commandEvent||!consumedEvent||!outEvent||!outAck||!readIoEvent||!writeIoEvent)return 70;
  writer=CreateThread(NULL,0,write_thread,NULL,0,NULL);reader=CreateThread(NULL,0,read_thread,NULL,0,NULL);if(!writer||!reader)return 70;asyncOutput=TRUE;
  BOOL registered=SetConsoleCtrlHandler(control,TRUE);
  if(api("register-handler",registered))return 71;
  if(api("enable-own-ctrl-c",SetConsoleCtrlHandler(NULL,FALSE)))return 71;
  Baseline b;if(capture(&b)){event("baseline-failed",NULL);return 72;}
  char state[4096],fields[4700];state_json(state,sizeof state);snprintf(fields,sizeof fields,",\"registered\":true,\"enabled\":true,\"baseline\":%s,\"buffer\":[%d,%d,%d,%d,%d,%d]",state,b.buffer.dwSize.X,b.buffer.dwSize.Y,b.buffer.srWindow.Left,b.buffer.srWindow.Top,b.buffer.srWindow.Right,b.buffer.srWindow.Bottom);
  if(!event("ready",fields))return 73;
  BOOL admitted=FALSE;char action[48];
  for(;;){int r=next_command(action,INFINITE);if(r<0){event("command-disconnected",NULL);return 74;}if(!strcmp(action,"abort")){if(!admitted){event("aborted-before-admit",NULL);return 0;}event("protocol-error",NULL);continue;}
   if(!strcmp(action,"admit")&&!admitted){admitted=TRUE;event("admitted",NULL);continue;}
   if(admitted&&!strncmp(action,"modes-",6)){
    char *end=NULL;unsigned long mask=strtoul(action+6,&end,10);
    if(modesRegistered||!end||*end||mask>511){event("protocol-error",NULL);continue;}
    if((mask&7)&&((mask&7)&((mask&7)-1))){event("protocol-error",NULL);continue;}
    if((mask&(1u<<3))&&(mask&(1u<<8))){event("protocol-error",NULL);continue;}
    originalModes=(DWORD)mask;modesRegistered=TRUE;char f[100];snprintf(f,sizeof f,",\"originalMask\":%lu",originalModes);
    event("modes-admitted",f);continue;
   }
   if(admitted&&!strcmp(action,"activate")){activate_buffer();continue;}
   if(admitted&&!strcmp(action,"permit-modes")&&bufferPhase==2&&!finalizing){modesPermitted=TRUE;event("modes-permitted",NULL);continue;}
   if(admitted&&!strncmp(action,"identify-",9)){
    char *end=NULL;DWORD pid=strtoul(action+9,&end,10);if(!pid||!end||*end){event("protocol-error",NULL);continue;}
    HANDLE h=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid);char f[180];
    if(!h)snprintf(f,sizeof f,",\"targetPID\":%lu,\"absent\":true,\"error\":%lu",pid,GetLastError());
    else{snprintf(f,sizeof f,",\"targetPID\":%lu,\"targetBorn\":\"%llu\",\"exited\":%s",pid,born(h),WaitForSingleObject(h,0)==WAIT_OBJECT_0?"true":"false");CloseHandle(h);}event("identity",f);continue;
   }
   if(!strncmp(action,"restore-",8)){char *end=NULL;closeDeadline=_strtoui64(action+8,&end,10);if(!end||*end||!closeDeadline){event("protocol-error",NULL);continue;}return restore(&b);}
   event("protocol-error",NULL);
  }
 }
 return 64;
}
