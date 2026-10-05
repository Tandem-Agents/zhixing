#define _GNU_SOURCE
#include <node_api.h>
#include <pthread.h>
#include <spawn.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <stdbool.h>
#include "posix-process.h"

#define CHILDREN 32
#define TEXT_MAX 32768
#define BLOCK_MAX (2 * 1024 * 1024)
typedef struct {
  uint32_t id; bool occupied, ready, created, resumed, cancelled, finished, exited, detached, group_active;
  int scope, error, exit_code, control;
  int owner_control, rights, payload[4], payload_count;
  bool tty, owner, private_channels, host_channels, channels_sent;
  pid_t pid;
  char birth[64];
  char **argv, **environment;
  napi_async_work work;
} Child;
static Child children[CHILDREN];
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static bool sealed;
static uint32_t generation;

static void close_fd(int *fd) { if (*fd >= 0) close(*fd); *fd = -1; }
static void close_channels(Child *child) {
  close_fd(&child->control); close_fd(&child->owner_control); close_fd(&child->rights);
  for (int i = 0; i < 4; i++) close_fd(&child->payload[i]);
}
/* Keep source descriptors above the fixed child slots. dup2 file actions must
 * not overwrite a still-needed source when the parent's low slots are free. */
static int channel_pair(int type, int pair[2]) {
  int raw[2]; if (socketpair(AF_UNIX, type, 0, raw)) return errno;
  pair[0] = fcntl(raw[0], F_DUPFD_CLOEXEC, 16);
  pair[1] = fcntl(raw[1], F_DUPFD_CLOEXEC, 16);
  int error = pair[0] < 0 || pair[1] < 0 ? errno : 0;
  close(raw[0]); close(raw[1]);
  if (error) { close_fd(&pair[0]); close_fd(&pair[1]); }
  return error;
}

static napi_value fail(napi_env env, const char *message) { napi_throw_error(env, NULL, message); return NULL; }
static napi_value nothing(napi_env env) { napi_value result; napi_get_undefined(env, &result); return result; }
static void free_vector(char **items) { if (items) { for (size_t i = 0; items[i]; i++) free(items[i]); free(items); } }
static char *text(napi_env env, napi_value value, size_t *budget) {
  size_t length = 0, written = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > TEXT_MAX || length + 1 > *budget) return NULL;
  char *result = malloc(length + 1);
  if (!result || napi_get_value_string_utf8(env, value, result, length + 1, &written) != napi_ok || written != length || strlen(result) != length) { free(result); return NULL; }
  *budget -= length + 1; return result;
}
static char **vector(napi_env env, napi_value value, size_t *budget, size_t prefix) {
  uint32_t length; bool array = false;
  if (napi_is_array(env, value, &array) != napi_ok || !array || napi_get_array_length(env, value, &length) != napi_ok || length > 1024) return NULL;
  char **result = calloc(prefix + length + 1, sizeof(char *));
  if (!result) return NULL;
  for (uint32_t i = 0; i < length; i++) {
    napi_value item; napi_get_element(env, value, i, &item);
    result[prefix + i] = text(env, item, budget);
    if (!result[prefix + i]) { for (size_t j = prefix; j < prefix + i; j++) free(result[j]); free(result); return NULL; }
  }
  return result;
}
static Child *child_arg(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1; uint32_t id;
  if (napi_get_cb_info(env, info, &count, &arg, NULL, NULL) != napi_ok || count != 1 || napi_get_value_uint32(env, arg, &id) != napi_ok || !id || !children[id % CHILDREN].occupied || children[id % CHILDREN].id != id) { fail(env, "terminal-native-child-identity"); return NULL; }
  return &children[id % CHILDREN];
}
static void stop_locked(Child *child) {
  child->cancelled = true;
  close_channels(child);
  // Never signal a reaped numeric PID. Only this module reaps these children.
  if (child->created && !child->exited) {
    if(child->scope==3 && getpgid(child->pid)==child->pid && kill(-child->pid,SIGKILL) && errno!=ESRCH)child->error=errno;
    if(kill(child->pid, SIGKILL) && errno != ESRCH) child->error = errno;
  }
}
static void execute(napi_env env, void *opaque) {
  (void)env; Child *child = opaque;
  int sockets[2] = {-1, -1}, owners[2] = {-1, -1}, rights[2] = {-1, -1};
  int payload[4][2] = {{-1,-1},{-1,-1},{-1,-1},{-1,-1}}, error = 0; pid_t pid = 0;
  posix_spawn_file_actions_t actions; posix_spawnattr_t attributes;
  bool actions_ok = false, attributes_ok = false;
  error = channel_pair(SOCK_STREAM, sockets);
  if (!error && child->owner) error = channel_pair(SOCK_STREAM, owners);
  if (!error && child->owner) error = channel_pair(SOCK_DGRAM, rights);
  for (int i = 0; !error && i < child->payload_count; i++) error = channel_pair(SOCK_STREAM, payload[i]);
  if (!error) { error = posix_spawn_file_actions_init(&actions); actions_ok = !error; }
  if (!error) { error = posix_spawnattr_init(&attributes); attributes_ok = !error; }
  if (!error) error = posix_spawn_file_actions_adddup2(&actions, sockets[1], 3);
  if (!error && child->owner) error = posix_spawn_file_actions_adddup2(&actions, owners[1], 4);
  if (!error && child->owner) error = posix_spawn_file_actions_adddup2(&actions, rights[1], 5);
  for (int i = 0; !error && i < child->payload_count; i++) error = posix_spawn_file_actions_adddup2(&actions, payload[i][1], 6 + i);
  if (!error && child->scope != 0 && !child->tty) {
    for (int fd = 0; fd < 3 && !error; fd++) error = posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", O_RDWR, 0);
  }
  sigset_t mask, defaults; sigemptyset(&mask); sigemptyset(&defaults);
  const int signals[] = {SIGINT, SIGTERM, SIGHUP, SIGQUIT};
  for (size_t i = 0; i < sizeof signals / sizeof signals[0]; i++) sigaddset(&mask, signals[i]);
  for (int i = 1; i < NSIG; i++) if (i != SIGKILL && i != SIGSTOP) sigaddset(&defaults, i);
  if (!error) error = posix_spawnattr_setsigmask(&attributes, &mask);
  if (!error) error = posix_spawnattr_setsigdefault(&attributes, &defaults);
  if (!error) error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  pthread_mutex_lock(&mutex); bool cancelled = sealed || child->cancelled; pthread_mutex_unlock(&mutex);
  if (!error && cancelled) error = ECANCELED;
  if (!error) error = posix_spawn(&pid, child->argv[0], &actions, &attributes, child->argv, child->environment);
  if (actions_ok) posix_spawn_file_actions_destroy(&actions);
  if (attributes_ok) posix_spawnattr_destroy(&attributes);
  close_fd(&sockets[1]); close_fd(&owners[1]); close_fd(&rights[1]);
  for (int i = 0; i < 4; i++) close_fd(&payload[i][1]);
  pthread_mutex_lock(&mutex);
  child->error = error; child->ready = true;
  if (!error) {
    child->pid = pid; child->created = true; child->control = sockets[0]; sockets[0] = -1;
    child->owner_control = owners[0]; owners[0] = -1;
    child->rights = rights[0]; rights[0] = -1;
    for (int i = 0; i < child->payload_count; i++) { child->payload[i] = payload[i][0]; payload[i][0] = -1; }
    if (zx_birth(pid, child->birth, sizeof child->birth)) child->birth[0] = 0;
    if (sealed || child->cancelled) stop_locked(child);
  }
  pthread_mutex_unlock(&mutex);
  close_fd(&sockets[0]); close_fd(&owners[0]); close_fd(&rights[0]);
  for (int i = 0; i < 4; i++) close_fd(&payload[i][0]);
  free_vector(child->argv); free_vector(child->environment); child->argv = child->environment = NULL;
}
static void complete(napi_env env, napi_status status, void *opaque) {
  Child *child = opaque;
  pthread_mutex_lock(&mutex);
  if (status != napi_ok && !child->ready) { child->error = ECANCELED; child->ready = true; }
  child->finished = true;
  pthread_mutex_unlock(&mutex);
  napi_delete_async_work(env, child->work); child->work = NULL;
}
/* gate, executable, argv, environment entries, cwd, inherited tty, scope,
 * fixed channel mode. All arguments are bounded. No pathname endpoints. */
static napi_value create(napi_env env, napi_callback_info info) {
  napi_value args[8], resource, result; size_t count = 8, budget = BLOCK_MAX; uint32_t scope = 1; bool tty = false;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 8 || napi_get_value_bool(env, args[5], &tty) != napi_ok || napi_get_value_uint32(env, args[6], &scope) != napi_ok || scope > 3) return fail(env, "terminal-native-create-arguments");
  size_t slot = 0; while (slot < CHILDREN && children[slot].occupied) slot++;
  if (sealed || slot == CHILDREN || generation >= 0x07ffffff) return fail(env, "terminal-native-admission-closed");
  Child *child = &children[slot]; memset(child, 0, sizeof *child);
  child->control = child->owner_control = child->rights = -1;
  for (int i=0;i<4;i++) child->payload[i]=-1;
  child->tty = tty;
  child->argv = vector(env, args[2], &budget, 6); child->environment = vector(env, args[3], &budget, 0);
  if (child->argv) {
    child->argv[0] = text(env, args[0], &budget); child->argv[1] = strdup("owned");
    char mode[2] = {(char)('0' + scope), 0}; child->argv[2] = strdup(mode);
    child->argv[3] = text(env, args[7], &budget);
    child->argv[4] = text(env, args[4], &budget); child->argv[5] = text(env, args[1], &budget);
  }
  bool valid = child->argv && child->environment;
  for (size_t i = 0; valid && i < 6; i++) valid = child->argv[i] != NULL;
  if (valid) {
    const char *mode=child->argv[3];
    child->owner=!strcmp(mode,"owner") || !strcmp(mode,"private-owner");
    child->private_channels=!strcmp(mode,"private") || !strcmp(mode,"private-owner");
    child->host_channels=!strcmp(mode,"host");
    child->payload_count=child->private_channels?4:child->host_channels?1:0;
    valid=child->owner || child->private_channels || child->host_channels || !strcmp(mode,"control") || !strcmp(mode,"stdio") || !strcmp(mode,"none");
  }
  if (!valid || !child->argv[0][0] || !child->argv[4][0] || !child->argv[5][0]) {
    // Prefix fields may contain holes following a rejected JS argument.
    if (child->argv) { for (size_t i = 0; i < 6; i++) { free(child->argv[i]); child->argv[i] = NULL; } for (size_t i = 6; child->argv[i]; i++) free(child->argv[i]); free(child->argv); }
    free_vector(child->environment); memset(child, 0, sizeof *child); return fail(env, "terminal-native-create-preflight");
  }
  child->id = ++generation * CHILDREN + (uint32_t)slot; child->scope = (int)scope; child->occupied = true;
  napi_create_string_utf8(env, "terminal-posix-create", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_async_work(env, NULL, resource, execute, complete, child, &child->work) != napi_ok || napi_queue_async_work(env, child->work) != napi_ok) {
    if (child->work) napi_delete_async_work(env, child->work);
    free_vector(child->argv); free_vector(child->environment); memset(child, 0, sizeof *child); return fail(env, "terminal-native-create-worker");
  }
  napi_create_uint32(env, child->id, &result); return result;
}
static napi_value resume(napi_env env, napi_callback_info info) {
  Child *child = child_arg(env, info); if (!child) return NULL;
  pthread_mutex_lock(&mutex);
  bool allowed = !sealed && !child->cancelled && child->created && !child->resumed && !child->exited && child->control >= 0;
  int transferred=-1;
  if (allowed && child->payload_count && !child->channels_sent) allowed=false;
  if (allowed) {
#ifdef __APPLE__
    int yes = 1;
    allowed = !setsockopt(child->control, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof yes) && send(child->control, "G", 1, 0) == 1;
#else
    allowed = send(child->control, "G", 1, MSG_NOSIGNAL) == 1;
#endif
    if (allowed) { child->resumed = true; transferred=child->control; child->control=-1; }
    else close_fd(&child->control);
  }
  pthread_mutex_unlock(&mutex);
  if (!allowed) return fail(env, "terminal-native-resume-denied");
  napi_value result; napi_create_int32(env,transferred,&result);return result;
}
static napi_value take_owner(napi_env env,napi_callback_info info) {
  Child *child=child_arg(env,info);if(!child)return NULL;
  pthread_mutex_lock(&mutex);int fd=child->owner_control;
  if(child->cancelled || !child->created)fd=-1;
  if(fd>=0)child->owner_control=-1;
  pthread_mutex_unlock(&mutex);
  if(fd<0)return fail(env,"terminal-native-owner-channel");
  napi_value result;napi_create_int32(env,fd,&result);return result;
}
/* Datagram payload carries identity metadata only. Both payload endpoint
 * copies are already out of S before the owner is permitted to write a plan. */
typedef struct { uint32_t magic,version,generation,count; char ticket[37]; } ChannelHeader;
static napi_value send_channels(napi_env env,napi_callback_info info) {
  napi_value args[3];size_t count=3;uint32_t id,owner_id;char ticket[37];size_t length;
  if(napi_get_cb_info(env,info,&count,args,NULL,NULL)!=napi_ok || count!=3 ||
     napi_get_value_uint32(env,args[0],&id)!=napi_ok || napi_get_value_uint32(env,args[1],&owner_id)!=napi_ok ||
     napi_get_value_string_utf8(env,args[2],ticket,sizeof ticket,&length)!=napi_ok || length!=36)
    return fail(env,"terminal-native-channel-ticket");
  for(size_t i=0;i<36;i++)if(!((ticket[i]>='0'&&ticket[i]<='9')||(ticket[i]>='a'&&ticket[i]<='f')||ticket[i]=='-'))return fail(env,"terminal-native-channel-ticket");
  Child *child=&children[id%CHILDREN],*owner=&children[owner_id%CHILDREN];
  pthread_mutex_lock(&mutex);
  bool valid=id&&owner_id&&child->occupied&&child->id==id&&owner->occupied&&owner->id==owner_id&&
    child->created&&!child->cancelled&&!child->resumed&&!child->channels_sent&&child->payload_count&&
    owner->created&&!owner->cancelled&&!owner->exited&&owner->rights>=0;
  int error=0;
  if(valid){
    ChannelHeader header={0};header.magic=0x5a584644;header.version=1;header.generation=id;header.count=(uint32_t)child->payload_count;memcpy(header.ticket,ticket,37);
    struct iovec iov={&header,sizeof header};union { struct cmsghdr alignment; char bytes[CMSG_SPACE(4*sizeof(int))]; } ancillary={0};
    struct msghdr message={0};message.msg_iov=&iov;message.msg_iovlen=1;message.msg_control=ancillary.bytes;message.msg_controllen=CMSG_SPACE(child->payload_count*sizeof(int));
    struct cmsghdr *cmsg=CMSG_FIRSTHDR(&message);cmsg->cmsg_level=SOL_SOCKET;cmsg->cmsg_type=SCM_RIGHTS;cmsg->cmsg_len=CMSG_LEN(child->payload_count*sizeof(int));memcpy(CMSG_DATA(cmsg),child->payload,child->payload_count*sizeof(int));
    ssize_t sent=sendmsg(owner->rights,&message,MSG_DONTWAIT
#ifndef __APPLE__
      |MSG_NOSIGNAL
#endif
    );
    if(sent!=(ssize_t)sizeof header)error=errno?errno:EIO;
    else {child->channels_sent=true;for(int i=0;i<4;i++)close_fd(&child->payload[i]);}
  }
  pthread_mutex_unlock(&mutex);
  return valid&&!error?nothing(env):fail(env,"terminal-native-channel-handoff");
}
/* Owner-side only: fixed inherited datagram lane, never a data/JSON stream.
 * No process, path, role or arbitrary descriptor argument is accepted. */
static napi_value receive_channels(napi_env env,napi_callback_info info) {
  (void)info;ChannelHeader header={0};int descriptors[64],received=0,type=0;socklen_t size=sizeof type;
  struct sockaddr_storage address;socklen_t address_size=sizeof address;
  if(getsockopt(5,SOL_SOCKET,SO_TYPE,&type,&size)||type!=SOCK_DGRAM||getsockname(5,(struct sockaddr*)&address,&address_size)||address.ss_family!=AF_UNIX||fcntl(5,F_SETFD,FD_CLOEXEC))return fail(env,"terminal-native-rights-lane");
  union {struct cmsghdr alignment;char bytes[CMSG_SPACE(64*sizeof(int))];} ancillary={0};
  struct iovec iov={&header,sizeof header};struct msghdr message={0};message.msg_iov=&iov;message.msg_iovlen=1;message.msg_control=ancillary.bytes;message.msg_controllen=sizeof ancillary.bytes;
  ssize_t length=recvmsg(5,&message,MSG_DONTWAIT
#ifdef __linux__
    |MSG_CMSG_CLOEXEC
#endif
  );
  if(length<0&&(errno==EAGAIN||errno==EWOULDBLOCK))return nothing(env);
  bool valid=length==(ssize_t)sizeof header && !(message.msg_flags&(MSG_CTRUNC|MSG_TRUNC));
  for(struct cmsghdr *cmsg=CMSG_FIRSTHDR(&message);cmsg;cmsg=CMSG_NXTHDR(&message,cmsg)){
    if(cmsg->cmsg_level!=SOL_SOCKET||cmsg->cmsg_type!=SCM_RIGHTS||cmsg->cmsg_len<CMSG_LEN(0)){valid=false;continue;}
    size_t bytes=cmsg->cmsg_len-CMSG_LEN(0);if(bytes%sizeof(int)){valid=false;continue;}
    size_t n=bytes/sizeof(int);int *fds=(int*)CMSG_DATA(cmsg);
    for(size_t i=0;i<n;i++){if(received<64)descriptors[received++]=fds[i];else{close(fds[i]);valid=false;}}
  }
  valid=valid&&header.magic==0x5a584644&&header.version==1&&header.generation&&
    (header.count==1||header.count==4)&&header.count==(uint32_t)received&&header.ticket[36]==0;
  for(int i=0;i<received;i++){
    type=0;size=sizeof type;address_size=sizeof address;
    if(fcntl(descriptors[i],F_SETFD,FD_CLOEXEC)||getsockopt(descriptors[i],SOL_SOCKET,SO_TYPE,&type,&size)||type!=SOCK_STREAM||getsockname(descriptors[i],(struct sockaddr*)&address,&address_size)||address.ss_family!=AF_UNIX)valid=false;
  }
  if(!valid){for(int i=0;i<received;i++)close(descriptors[i]);return fail(env,"terminal-native-channel-invalid");}
  napi_value result,array,value;napi_create_object(env,&result);napi_create_array_with_length(env,(size_t)received,&array);
  for(int i=0;i<received;i++){napi_create_int32(env,descriptors[i],&value);napi_set_element(env,array,(uint32_t)i,value);}napi_set_named_property(env,result,"fds",array);
  napi_create_string_utf8(env,header.ticket,36,&value);napi_set_named_property(env,result,"ticket",value);
  napi_create_uint32(env,header.generation,&value);napi_set_named_property(env,result,"generation",value);return result;
}
static napi_value stop(napi_env env, napi_callback_info info) {
  Child *child = child_arg(env, info); if (!child) return NULL;
  napi_value args[2];size_t count=2;int signal=SIGKILL;
  napi_get_cb_info(env,info,&count,args,NULL,NULL);
  if(count==2&&(napi_get_value_int32(env,args[1],&signal)!=napi_ok || (signal!=SIGKILL&&signal!=SIGTERM&&signal!=SIGINT&&signal!=SIGHUP&&signal!=SIGQUIT)))return fail(env,"terminal-native-signal");
  pthread_mutex_lock(&mutex);
  if(!child->resumed||signal==SIGKILL)stop_locked(child);
  else { child->cancelled=true;if(child->created&&!child->exited){
    if(child->scope==3&&getpgid(child->pid)==child->pid&&kill(-child->pid,signal)&&errno!=ESRCH)child->error=errno;
    if(kill(child->pid,signal)&&errno!=ESRCH)child->error=errno;
  } }
  pthread_mutex_unlock(&mutex);return nothing(env);
}
static void boolean(napi_env env, napi_value result, const char *key, bool value) { napi_value v; napi_get_boolean(env, value, &v); napi_set_named_property(env, result, key, v); }
static void number(napi_env env, napi_value result, const char *key, int value) { napi_value v; napi_create_int32(env, value, &v); napi_set_named_property(env, result, key, v); }
static void reap_locked(Child *child) {
  if (!child->created) return;
  if(child->exited) {
    // Observation only after reap. No signal that can affect another process
    // is ever sent to this PGID after its root identity was released.
    if(child->group_active && kill(-child->pid,0)<0 && errno==ESRCH)child->group_active=false;
    return;
  }
  if(child->scope==3) {
    siginfo_t pending={0};
    if(waitid(P_PID,(id_t)child->pid,&pending,WEXITED|WNOHANG|WNOWAIT)<0){if(errno!=EINTR)child->error=errno;return;}
    if(!pending.si_pid)return;
    // Keep the root zombie pinned until the final group termination. The gate
    // makes a fresh session before executing any external command.
    // A live/unreaped root reserves its numeric identity. Its fresh PGID is
    // either this operation's group or absent; it cannot already be reused.
    if(!kill(-child->pid,SIGKILL))child->group_active=true;
    else if(errno==ESRCH)child->group_active=false;
    else {child->group_active=true;child->error=errno;}
  }
  int status = 0; pid_t observed = waitpid(child->pid, &status, WNOHANG);
  if (observed == child->pid) { child->exited = true; child->exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 71; }
  else if (observed < 0 && errno != EINTR) child->error = errno; // ECHILD is unknown, not an exit receipt.
}
static napi_value observe(napi_env env, napi_callback_info info) {
  Child *child = child_arg(env, info); if (!child) return NULL;
  napi_value result, birth; napi_create_object(env, &result);
  pthread_mutex_lock(&mutex); reap_locked(child);
  boolean(env,result,"ready",child->ready); boolean(env,result,"created",child->created); boolean(env,result,"resumed",child->resumed);
  boolean(env,result,"cancelled",child->cancelled); boolean(env,result,"creationExited",child->finished); boolean(env,result,"exited",child->exited);
  number(env,result,"pid",child->pid); number(env,result,"error",child->error); number(env,result,"exitCode",child->error ? 71 : child->exit_code);
  number(env,result,"branchActive",(child->created && !child->exited)||child->group_active ? 1 : 0);
  napi_create_string_utf8(env,child->birth,NAPI_AUTO_LENGTH,&birth); napi_set_named_property(env,result,"birth",birth);
  pthread_mutex_unlock(&mutex); return result;
}
static napi_value seal(napi_env env, napi_callback_info info) { (void)info; pthread_mutex_lock(&mutex); sealed = true; for (size_t i=0;i<CHILDREN;i++) if (children[i].occupied && !children[i].resumed) stop_locked(&children[i]); pthread_mutex_unlock(&mutex); return nothing(env); }
static napi_value release(napi_env env, napi_callback_info info) {
  Child *child = child_arg(env, info); if (!child) return NULL;
  if (!child->finished || (child->created && !child->exited) || child->group_active) return fail(env,"terminal-native-release-live");
  close_channels(child); memset(child,0,sizeof *child); return nothing(env);
}
static napi_value detach(napi_env env, napi_callback_info info) {
  Child *child=child_arg(env,info); if(!child)return NULL;
  if(child->scope!=2 || !child->finished || !child->resumed)return fail(env,"terminal-native-detach-denied");
  close_channels(child); child->detached=true; return nothing(env);
}
static napi_value execution(napi_env env,napi_callback_info info) {
  (void)info; int active=0,creating=0,owned_active=0,owned_creating=0; napi_value result; napi_create_object(env,&result);
  pthread_mutex_lock(&mutex);
  for(size_t i=0;i<CHILDREN;i++)if(children[i].occupied){Child *c=&children[i];reap_locked(c);if(c->detached&&c->exited&&c->finished){memset(c,0,sizeof *c);continue;}if(c->scope==1||c->scope==3){if(!c->finished)creating++;if((c->created&&!c->exited)||c->group_active)active++;}if(c->scope==1){if(!c->finished)owned_creating++;if(c->created&&!c->exited)owned_active++;}}
  pthread_mutex_unlock(&mutex); number(env,result,"active",active);number(env,result,"creating",creating);
  number(env,result,"ownedActive",owned_active);number(env,result,"ownedCreating",owned_creating);return result;
}
static napi_value terminate(napi_env env,napi_callback_info info){(void)info;pthread_mutex_lock(&mutex);for(size_t i=0;i<CHILDREN;i++)if(children[i].occupied&&(children[i].scope==1||children[i].scope==3))stop_locked(&children[i]);pthread_mutex_unlock(&mutex);return nothing(env);}
static napi_value init(napi_env env,napi_value exports){
  const napi_property_descriptor properties[]={
    {"createPosix",NULL,create,NULL,NULL,NULL,napi_default,NULL},{"resume",NULL,resume,NULL,NULL,NULL,napi_default,NULL},
    {"takeOwnerControl",NULL,take_owner,NULL,NULL,NULL,napi_default,NULL},{"sendChannels",NULL,send_channels,NULL,NULL,NULL,napi_default,NULL},
    {"receiveChannels",NULL,receive_channels,NULL,NULL,NULL,napi_default,NULL},
    {"stop",NULL,stop,NULL,NULL,NULL,napi_default,NULL},{"observe",NULL,observe,NULL,NULL,NULL,napi_default,NULL},{"snapshot",NULL,observe,NULL,NULL,NULL,napi_default,NULL},
    {"seal",NULL,seal,NULL,NULL,NULL,napi_default,NULL},{"release",NULL,release,NULL,NULL,NULL,napi_default,NULL},{"detach",NULL,detach,NULL,NULL,NULL,napi_default,NULL},
    {"executionState",NULL,execution,NULL,NULL,NULL,napi_default,NULL},{"terminateExecution",NULL,terminate,NULL,NULL,NULL,napi_default,NULL}};
  napi_define_properties(env,exports,sizeof properties/sizeof properties[0],properties);return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
