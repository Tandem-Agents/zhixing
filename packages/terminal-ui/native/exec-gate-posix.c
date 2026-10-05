#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/resource.h>
#include <poll.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include "posix-process.h"

#define PLAN_LIMIT (2 * 1024 * 1024)
static int read_plan(int fd,void *bytes,size_t length,uint64_t deadline) {
  size_t at=0;while(at<length){uint64_t now=zx_utc_ms();if(now>=deadline)return -1;
    struct pollfd p={fd,POLLIN,0};int ready=poll(&p,1,(int)(deadline-now));
    if(ready<0&&errno==EINTR)continue;if(ready<=0)return -1;
    ssize_t count=read(fd,(char *)bytes+at,length-at);if(count<0&&errno==EINTR)continue;if(count<=0)return -1;at+=(size_t)count;
  }return 0;
}
static uint32_t word(const unsigned char *bytes){return ((uint32_t)bytes[0]<<24)|((uint32_t)bytes[1]<<16)|((uint32_t)bytes[2]<<8)|bytes[3];}
static char *next_text(unsigned char **at,unsigned char *end) {
  if(end-*at<4)return NULL;uint32_t length=word(*at);*at+=4;
  if(length>32768 || (size_t)(end-*at)<length || memchr(*at,0,length))return NULL;
  char *text=malloc((size_t)length+1);if(!text)return NULL;
  memcpy(text,*at,length);text[length]=0;*at+=length;return text;
}
static int private_exec(int argc,char **argv) {
  // Fixed plan/stdin/stdout/stderr slots, already transferred directly to the
  // owner. S has closed all of its copies before the execution permit.
  if(argc!=5)return 64;char *end;uint64_t deadline=strtoull(argv[4],&end,10);
  if(*end||deadline<=zx_utc_ms()||deadline-zx_utc_ms()>5000)return 64;
  signal(SIGPIPE,SIG_IGN);
  int plan=6;
  unsigned char header[4];if(read_plan(plan,header,4,deadline))return 73;
  uint32_t length=word(header);if(length<12||length>PLAN_LIMIT)return 64;
  unsigned char *bytes=malloc(length);if(!bytes||read_plan(plan,bytes,length,deadline))return 73;close(plan);
  unsigned char *at=bytes,*limit=bytes+length;uint32_t version=word(at),args=word(at+4),envs=word(at+8);at+=12;
  if(version!=1||args>1024||envs>1024)return 64;
  char *executable=next_text(&at,limit),*directory=next_text(&at,limit);
  char **arguments=calloc((size_t)args+2,sizeof(char *));
  if(!executable||!executable[0]||!directory||!directory[0]||!arguments)return 64;
  arguments[0]=executable;
  for(uint32_t i=0;i<args;i++)if(!(arguments[i+1]=next_text(&at,limit)))return 64;
  // The gate inherited only S's fixed environment. Replace it with the private
  // owner plan, then overwrite the two S-issued lifecycle capabilities.
  extern char **environ;environ=calloc((size_t)envs+1,sizeof(char *));if(!environ)return 71;
  size_t env_count=0;
  for(uint32_t i=0;i<envs;i++){
    char *entry=next_text(&at,limit);if(!entry||!strchr(entry,'=')||entry[0]=='=')return 64;
    if(!strncmp(entry,"ZHIXING_TERMINAL_",17))free(entry);else environ[env_count++]=entry;
  }
  if(at!=limit||chdir(directory))return 64;
  if(argv[2][0]) {
    if(strlen(argv[2])!=36 || setenv("ZHIXING_TERMINAL_CREATE_FD","4",1) || setenv("ZHIXING_TERMINAL_RIGHTS_FD","5",1) ||
       setenv("ZHIXING_TERMINAL_CREATE_TOKEN",argv[2],1) || setenv("ZHIXING_TERMINAL_FOREGROUND",argv[3],1))return 71;
  } else {close(4);close(5);}
  free(bytes);
  for(int i=0;i<3;i++)if(dup2(7+i,i)<0)return 73;
  for(int i=7;i<=9;i++)close(i);
  if(zx_utc_ms()>=deadline)return 125;
  signal(SIGPIPE,SIG_DFL);
  execvp(executable,arguments);return errno==ENOENT?127:126;
}

/* A fixed, same-PID execution gate. It never creates another process. S owns
 * the gate before writing its one-byte permit; EOF never means permission. */
int main(int argc, char **argv) {
  if(argc>1&&!strcmp(argv[1],"private"))return private_exec(argc,argv);
  if (argc < 6 || strcmp(argv[1], "owned")) return 64;
  int scope = atoi(argv[2]);
  if (scope < 0 || scope > 3 || !argv[4][0] || !argv[5][0]) return 64;
  const char *mode=argv[3];
  bool owner=!strcmp(mode,"owner")||!strcmp(mode,"private-owner");
  bool private_channels=!strcmp(mode,"private")||!strcmp(mode,"private-owner");
  bool host=!strcmp(mode,"host"),stdio=!strcmp(mode,"stdio");
  bool control=!strcmp(mode,"control")||!strcmp(mode,"owner");
  if(!owner&&!private_channels&&!host&&!stdio&&!control&&strcmp(mode,"none"))return 64;
  // Only the fixed role slots survive. No generic inherited-FD list.
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit)) return 71;
#ifdef __APPLE__
  closefrom(10);
#else
  if (close_range(10, ~0u, 0)) {
    if (limit.rlim_cur == RLIM_INFINITY || limit.rlim_cur > 1048576) return 71;
    for (int fd = 10; fd < (int)limit.rlim_cur; fd++) close(fd);
  }
#endif
  char permit = 0;
  ssize_t count;
  do { count = read(3, &permit, 1); } while (count < 0 && errno == EINTR);
  if (count != 1 || permit != 'G') return 125;
  if(!owner){close(4);close(5);}
  for(int fd=6;fd<10;fd++)if(!private_channels&&!(host&&fd==6))close(fd);
  if(!control&&!stdio)close(3);
  if ((scope == 2 || scope == 3) && setsid() < 0) return 71;
  if (chdir(argv[4])) return 71;
  if (stdio) {
    if (dup2(3, 0) < 0 || dup2(3, 1) < 0) return 71;
    close(3);
  }
  // R installs handlers and captures its baseline before unblocking these.
  if (scope != 0) { sigset_t empty; sigemptyset(&empty); if (sigprocmask(SIG_SETMASK, &empty, NULL)) return 71; }
  execv(argv[5], &argv[5]);
  return errno == ENOENT ? 127 : 126;
}
