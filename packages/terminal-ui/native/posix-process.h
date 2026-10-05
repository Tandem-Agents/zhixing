#ifndef ZHIXING_POSIX_PROCESS_H
#define ZHIXING_POSIX_PROCESS_H
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#endif

static uint64_t zx_utc_ms(void) {
  struct timeval now;
  if (gettimeofday(&now, NULL)) return 0;
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_usec / 1000;
}

/* A birth token is for persisted observations only. Live children remain
 * unreaped, owned PID objects; signaling never relies on a pathname token. */
static int zx_birth(pid_t pid, char *out, size_t size) {
#ifdef __APPLE__
  struct proc_bsdinfo info;
  int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info);
  if (got != sizeof info) return errno ? errno : EIO;
  snprintf(out, size, "%llu%06llu", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
  return 0;
#else
  char name[64], text[8192];
  snprintf(name, sizeof name, "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(name, "re");
  if (!file) return errno;
  size_t count = fread(text, 1, sizeof text - 1, file);
  int error = ferror(file) ? EIO : 0;
  fclose(file); text[count] = 0;
  if (error || count == sizeof text - 1) return EIO;
  char *at = strrchr(text, ')');
  if (!at || at[1] != ' ') return EIO;
  at += 2;
  for (int field = 3; field < 22; field++) {
    at = strchr(at, ' '); if (!at) return EIO; at++;
  }
  char *end = NULL; errno = 0;
  unsigned long long ticks = strtoull(at, &end, 10);
  if (errno || !ticks || end == at || *end != ' ') return EIO;
  snprintf(out, size, "%llu", ticks); return 0;
#endif
}
#endif
