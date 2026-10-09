#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <termios.h>
#include <signal.h>
#include <fcntl.h>
#include <poll.h>
#include <stdbool.h>
#include <limits.h>
#include "posix-process.h"
#include "mode-contract.h"

/* The original R keeps the only baseline. It neither reads TTY input nor
 * creates/reaps children; only S may admit final restoration after writers. */
typedef struct { struct termios term[3]; struct stat identity[3]; int flags[3], descriptor_flags[3]; pid_t session, group; } Baseline;
static int channel = -1, output = -1;
static volatile sig_atomic_t controls;
static char instance[37], birth[64];
static unsigned long sequence;
static uint64_t deadline;
static bool registered, permitted, admitted, finalizing;
static unsigned original_modes, mutable_modes;
static int buffer_phase; /* 0 untouched, 1 attempting, 2 entered, 3 leaving, 4 returned, 5 unknown */
static void control(int signal) { (void)signal; if (controls < 32767) controls++; }
static uint64_t end_time(uint64_t maximum) { uint64_t end = zx_utc_ms() + maximum; return deadline && deadline < end ? deadline : end; }
static int write_until(int fd, const void *bytes, size_t length, uint64_t end) {
  size_t at = 0;
  while (at < length) {
    uint64_t now = zx_utc_ms(); if (now >= end) return ETIMEDOUT;
    struct pollfd pollfd = {fd, POLLOUT, 0};
    int ready = poll(&pollfd, 1, (int)(end - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || !(pollfd.revents & POLLOUT)) return ready < 0 ? errno : EIO;
    ssize_t count = write(fd, (const char *)bytes + at, length - at);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count <= 0) return count < 0 ? errno : EIO;
    at += (size_t)count;
  }
  return 0;
}
static bool event(const char *name, const char *fields) {
  char text[2048];
  int length = snprintf(text, sizeof text, "{\"v\":1,\"instance\":\"%s\",\"seq\":%lu,\"pid\":%ld,\"born\":\"%s\",\"event\":\"%s\"%s}\n", instance, ++sequence, (long)getpid(), birth, name, fields ? fields : "");
  return length > 0 && length < (int)sizeof text && !write_until(channel, text, (size_t)length, end_time(1000));
}
static bool same_object(const struct stat *a,const struct stat *b) { return a->st_dev==b->st_dev && a->st_ino==b->st_ino && a->st_rdev==b->st_rdev && S_ISCHR(b->st_mode); }
static bool foreground(const Baseline *baseline) {
  struct stat current;
  return getsid(0)==baseline->session && getpgrp()==baseline->group && tcgetpgrp(output)==baseline->group && !fstat(output,&current) && same_object(&baseline->identity[1],&current);
}
static int effect(const Baseline *baseline,const char *bytes) {
  if (!foreground(baseline)) return 1;
  return write_until(output,bytes,strlen(bytes),end_time(500)) ? 1 : 0;
}
static bool same_term(const struct termios *a,const struct termios *b) {
  return a->c_iflag==b->c_iflag && a->c_oflag==b->c_oflag && a->c_cflag==b->c_cflag && a->c_lflag==b->c_lflag &&
    cfgetispeed(a)==cfgetispeed(b) && cfgetospeed(a)==cfgetospeed(b) && !memcmp(a->c_cc,b->c_cc,sizeof a->c_cc);
}
static int restore(Baseline *baseline) {
  finalizing=true; int errors=0;
  if (!foreground(baseline)) errors++;
  else {
    if (buffer_phase==2) { buffer_phase=3; if (effect(baseline,"\033[?1049l")) { errors++;buffer_phase=5; } else buffer_phase=4; }
    else if (buffer_phase!=0 && buffer_phase!=4) errors++;
    if (permitted) {
      char modes[256]; size_t at=0;
      for (int i=0;i<9;i++) if(i!=6 && (mutable_modes&(1u<<i)) && !(original_modes&(1u<<i))) at+=(size_t)snprintf(modes+at,sizeof modes-at,"\033[?%ul",mode_ids[i]);
      for (int i=0;i<9;i++) if(i!=6 && (mutable_modes&original_modes&(1u<<i))) at+=(size_t)snprintf(modes+at,sizeof modes-at,"\033[?%uh",mode_ids[i]);
      if(at>=sizeof modes || effect(baseline,modes))errors++;
    }
    // Returning to the original screen restores its saved cursor. R cannot
    // query input or inspect arbitrary scrollback; one CR/LF hands off a line.
    if (buffer_phase==4 && effect(baseline,"\r\n")) errors++;
    const int order[3]={1,2,0};
    for(int i=0;i<3;i++) {
      int fd=order[i]; struct stat object;
      if(zx_utc_ms()>=deadline || !foreground(baseline) || fstat(fd,&object) || !same_object(&baseline->identity[fd],&object)) {errors++;continue;}
      // The standard descriptors commonly name one TTY. Restore its complete
      // termios once through fd 0, last, rather than resetting input early via
      // an aliased output descriptor.
      if((fd==0||!same_object(&baseline->identity[fd],&baseline->identity[0]))&&tcsetattr(fd,TCSANOW,&baseline->term[fd]))errors++;
      if(fcntl(fd,F_SETFL,baseline->flags[fd]))errors++;
      if(fcntl(fd,F_SETFD,baseline->descriptor_flags[fd]))errors++;
    }
    for(int fd=0;fd<3;fd++) { struct termios current;
      if(tcgetattr(fd,&current)||!same_term(&current,&baseline->term[fd])||fcntl(fd,F_GETFL)!=baseline->flags[fd]||fcntl(fd,F_GETFD)!=baseline->descriptor_flags[fd])errors++;
    }
  }
  char fields[100];snprintf(fields,sizeof fields,",\"errors\":%d,\"controls\":%d",errors,(int)controls);
  bool sent=event("result",fields);return errors||!sent?69:0;
}
int main(int argc,char **argv) {
  if(argc!=3||strcmp(argv[1],"resident")||strlen(argv[2])!=36)return 64;
  for(int i=0;i<36;i++)if(!((argv[2][i]>='0'&&argv[2][i]<='9')||(argv[2][i]>='a'&&argv[2][i]<='f')||argv[2][i]=='-'))return 64;
  memcpy(instance,argv[2],37);if(zx_birth(getpid(),birth,sizeof birth))return 71;
  const char *descriptor=getenv("ZHIXING_TERMINAL_FD");
  if(!descriptor||strcmp(descriptor,"3"))return 64;
  unsetenv("ZHIXING_TERMINAL_FD");channel=3;
  int socket_type=0;socklen_t socket_size=sizeof socket_type;
  if(getsockopt(channel,SOL_SOCKET,SO_TYPE,&socket_type,&socket_size)||socket_type!=SOCK_STREAM||fcntl(channel,F_SETFD,FD_CLOEXEC))return 73;
  if(fcntl(channel,F_SETFL,fcntl(channel,F_GETFL)|O_NONBLOCK))return 73;
  struct sigaction action={0};action.sa_handler=control;sigemptyset(&action.sa_mask);
  const int signals[]={SIGINT,SIGTERM,SIGHUP,SIGQUIT};
  for(size_t i=0;i<sizeof signals/sizeof signals[0];i++)if(sigaction(signals[i],&action,NULL))return 71;
  signal(SIGPIPE,SIG_IGN);
  Baseline baseline={0};baseline.session=getsid(0);baseline.group=getpgrp();
  for(int fd=0;fd<3;fd++) {
    baseline.flags[fd]=fcntl(fd,F_GETFL);
    baseline.descriptor_flags[fd]=fcntl(fd,F_GETFD);
    if(baseline.flags[fd]<0||baseline.descriptor_flags[fd]<0||fstat(fd,&baseline.identity[fd])||!S_ISCHR(baseline.identity[fd].st_mode)||tcgetattr(fd,&baseline.term[fd])||tcgetpgrp(fd)!=baseline.group||tcgetsid(fd)!=baseline.session)return 72;
  }
  char tty[PATH_MAX];if(ttyname_r(1,tty,sizeof tty))return 72;
  output=open(tty,O_WRONLY|O_NOCTTY|O_NONBLOCK|O_CLOEXEC);if(output<0||!foreground(&baseline))return 72;
  sigset_t empty;sigemptyset(&empty);if(sigprocmask(SIG_SETMASK,&empty,NULL))return 71;
#ifdef __APPLE__
  const char *platform="darwin";
#else
  const char *platform="linux";
#endif
  char ready[256];snprintf(ready,sizeof ready,",\"registered\":true,\"enabled\":true,\"baseline\":{\"platform\":\"%s\",\"terminal\":true,\"foreground\":true,\"modeErrors\":[0,0,0]}",platform);
  if(!event("ready",ready))return 73;
  char line[256];size_t used=0;sig_atomic_t seen=0;
  for(;;) {
    if(controls!=seen){seen=controls;char fields[64];snprintf(fields,sizeof fields,",\"count\":%d",(int)seen);if(!event("control",fields))return 74;}
    struct pollfd pollfd={channel,POLLIN,0};int result=poll(&pollfd,1,1000);
    if(result<0&&errno==EINTR)continue;if(result<0)return 74;if(!result)continue;
    char byte;ssize_t count=read(channel,&byte,1);if(count<0&&(errno==EINTR||errno==EAGAIN))continue;if(count!=1)return 74;
    if(byte!='\n'){if(used==sizeof line-1)return 70;line[used++]=byte;continue;}
    line[used]=0;used=0;unsigned version=0;char token[48],command[48],extra[2];
    if(sscanf(line,"%u %47s %47s %1s",&version,token,command,extra)!=3||version!=1||strcmp(token,instance)){event("protocol-error",NULL);continue;}
    if(!strcmp(command,"abort")&&!admitted)return 0;
    if(!strcmp(command,"admit")&&!admitted){admitted=true;event("admitted",NULL);continue;}
    if(admitted&&!strncmp(command,"modes-",6)) {
      char *end;unsigned long mask=strtoul(command+6,&end,10);
      if(*end!='-'){event("protocol-error",NULL);continue;}
      unsigned long mutable=strtoul(end+1,&end,10);
      if(registered||*end||mask>511||mutable>511||!(mutable&64)||((mask&7)&&((mask&7)&((mask&7)-1)))||((mask&8)&&(mask&256))){event("protocol-error",NULL);continue;}
      original_modes=(unsigned)mask;mutable_modes=(unsigned)mutable;registered=true;event("modes-admitted",NULL);continue;
    }
    if(admitted&&!strcmp(command,"activate")) {
      if(!registered||buffer_phase||finalizing||(original_modes&(1u<<6))){event("activation-denied",NULL);continue;}
      buffer_phase=1;if(effect(&baseline,"\033[?1049h")){buffer_phase=5;event("activation-failed",NULL);}else{buffer_phase=2;event("entered",NULL);}continue;
    }
    if(admitted&&!strcmp(command,"permit-modes")&&buffer_phase==2&&!finalizing){permitted=true;event("modes-permitted",NULL);continue;}
    if(admitted&&!strncmp(command,"identify-",9)) {
      char *end;long pid=strtol(command+9,&end,10);if(*end||pid<=0||pid>INT_MAX){event("protocol-error",NULL);continue;}
      char target[64],fields[180];int error=zx_birth((pid_t)pid,target,sizeof target);
      // ENOENT from /proc is absence only after kill(0) also reports ESRCH.
      bool absent=error && kill((pid_t)pid,0)<0 && errno==ESRCH;
      if(!error)snprintf(fields,sizeof fields,",\"targetPID\":%ld,\"targetBorn\":\"%s\"",pid,target);
      else snprintf(fields,sizeof fields,",\"targetPID\":%ld,\"absent\":%s,\"error\":%d",pid,absent?"true":"false",absent?ESRCH:error);
      event("identity",fields);continue;
    }
    if(!strncmp(command,"restore-",8)) {
      char *end;uint64_t requested=strtoull(command+8,&end,10),now=zx_utc_ms();
      if(*end||requested<=now||requested-now>8000){event("protocol-error",NULL);continue;}
      deadline=requested;return restore(&baseline);
    }
    event("protocol-error",NULL);
  }
}
