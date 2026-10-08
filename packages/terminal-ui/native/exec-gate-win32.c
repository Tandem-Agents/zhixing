#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Private N -> helper plan/stdio. S owns this gate's Job and sees only the
 * ticket and held target identity. No Node runtime, forwarding buffers or
 * polling loop is needed to keep these already-owned handles alive. */
#define PLAN_LIMIT (2u * 1024u * 1024u)
#define ITEMS 1024
static HANDLE admitted, targetJob, control = INVALID_HANDLE_VALUE;
static LONG finishing;
static ULONGLONG deadline;
static ULONGLONG now_ms(void) {
  FILETIME t; GetSystemTimeAsFileTime(&t);
  return ((((ULONGLONG)t.dwHighDateTime << 32) | t.dwLowDateTime) / 10000) - 11644473600000ULL;
}
static void fail(void) { ExitProcess(71); }
static DWORD WINAPI guard(void *unused) {
  (void)unused; ULONGLONG now = now_ms();
  if (WaitForSingleObject(admitted, now < deadline ? (DWORD)(deadline - now) : 0) != WAIT_OBJECT_0) fail();
  return 0;
}
static DWORD WINAPI watch_control(void *unused) {
  (void)unused; char extra; DWORD read;
  /* After resume there are no further messages on this lane. Revocation,
   * malformed traffic and S disappearing all revoke the existing Job. */
  ReadFile(control, &extra, 1, &read, NULL);
  if (!InterlockedCompareExchange(&finishing, 0, 0)) fail();
  return 0;
}
static BOOL guid(const wchar_t *s) {
  if (wcslen(s) != 36) return FALSE;
  for (int i = 0; i < 36; i++) if (!(s[i] == L'-' || (s[i] >= L'0' && s[i] <= L'9') || (s[i] >= L'a' && s[i] <= L'f'))) return FALSE;
  return TRUE;
}
static BOOL endpoint_valid(const wchar_t *s) {
  const wchar_t *prefix = L"\\\\.\\pipe\\zhixing-terminal-";
  size_t n = wcslen(prefix);
  return wcslen(s) == n + 36 && !wcsncmp(s, prefix, n) && guid(s + n);
}
static void write_all(HANDLE h, const char *bytes, DWORD count) {
  while (count) { DWORD written; if (!WriteFile(h, bytes, count, &written, NULL) || !written) fail(); bytes += written; count -= written; }
}
static void read_all(HANDLE h, void *data, DWORD count) {
  char *bytes = data;
  while (count) { DWORD read; if (!ReadFile(h, bytes, count, &read, NULL) || !read) fail(); bytes += read; count -= read; }
}
static HANDLE connect_pipe(const wchar_t *endpoint, BOOL inherit) {
  SECURITY_ATTRIBUTES security = { sizeof security, NULL, inherit };
  for (;;) {
    if (now_ms() >= deadline) fail();
    HANDLE h = CreateFileW(endpoint, GENERIC_READ | GENERIC_WRITE, 0, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) return h;
    if (GetLastError() != ERROR_PIPE_BUSY) fail();
    if (!WaitNamedPipeW(endpoint, 20) && GetLastError() != ERROR_SEM_TIMEOUT) fail();
  }
}
static HANDLE lane(const wchar_t *endpoint, const wchar_t *token, const char *kind, BOOL inherit) {
  HANDLE h = connect_pipe(endpoint, inherit); char hello[64];
  int n = snprintf(hello, sizeof hello, "%ls %s\n", token, kind);
  if (n < 1 || n >= (int)sizeof hello) fail(); write_all(h, hello, (DWORD)n); return h;
}
static uint32_t integer(const unsigned char *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static wchar_t *text(const unsigned char *data, uint32_t size, uint32_t *offset) {
  if (*offset > size || size - *offset < 4) fail();
  uint32_t n = integer(data + *offset); *offset += 4;
  if (n > 32768 || n > size - *offset || memchr(data + *offset, 0, n)) fail();
  int count = n ? MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)data + *offset, (int)n, NULL, 0) : 0;
  if (n && !count) fail();
  wchar_t *result = calloc((size_t)count + 1, sizeof(wchar_t)); if (!result) fail();
  if (count && !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)data + *offset, (int)n, result, count)) fail();
  *offset += n; return result;
}
static void erase(wchar_t *s) { if (s) { SecureZeroMemory(s, wcslen(s) * sizeof(wchar_t)); free(s); } }
static void character(wchar_t *command, size_t *used, wchar_t c) {
  if (*used >= 32766) fail(); command[(*used)++] = c;
}
static void argument(wchar_t *command, size_t *used, const wchar_t *s) {
  if (*used) character(command, used, L' ');
  character(command, used, L'"');
  for (size_t i = 0;;) {
    size_t slashes = 0; while (s[i] == L'\\') { slashes++; i++; }
    size_t count = (s[i] == L'"' || !s[i]) ? slashes * 2 : slashes;
    while (count--) character(command, used, L'\\');
    if (!s[i]) break;
    if (s[i] == L'"') character(command, used, L'\\');
    character(command, used, s[i++]);
  }
  character(command, used, L'"');
}
static BOOL same_key(const wchar_t *entry, const wchar_t *name) {
  size_t n = wcslen(name); return !_wcsnicmp(entry, name, n) && entry[n] == L'=';
}
static int environment_order(const void *a, const void *b) { return _wcsicmp(*(wchar_t *const *)a, *(wchar_t *const *)b); }
static void inherited_owner(wchar_t **entries, uint32_t *count, const wchar_t *name) {
  DWORD n = GetEnvironmentVariableW(name, NULL, 0); if (!n || n > 32768) fail();
  size_t key = wcslen(name); wchar_t *entry = calloc(key + 1 + n, sizeof(wchar_t)); if (!entry) fail();
  memcpy(entry, name, key * sizeof(wchar_t)); entry[key] = L'=';
  if (GetEnvironmentVariableW(name, entry + key + 1, n) != n - 1) fail();
  entries[(*count)++] = entry;
}
int wmain(int argc, wchar_t **argv) {
  if (argc != 5 || !endpoint_valid(argv[1]) || !guid(argv[2]) || (argv[4][0] && !guid(argv[4]))) return 64;
  wchar_t *end; deadline = _wcstoui64(argv[3], &end, 10);
  if (*end || deadline <= now_ms() || deadline > now_ms() + 5000) return 64;
  BOOL inJob = FALSE; if (!IsProcessInJob(GetCurrentProcess(), NULL, &inJob) || !inJob) return 64;
  admitted = CreateEventW(NULL, TRUE, FALSE, NULL); if (!admitted) fail();
  HANDLE watchdog = CreateThread(NULL, 0, guard, NULL, 0, NULL); if (!watchdog) fail();
  HANDLE plan = lane(argv[1], argv[2], "plan", FALSE); unsigned char header[4]; read_all(plan, header, 4);
  uint32_t size = integer(header); if (size < 12 || size > PLAN_LIMIT) fail();
  unsigned char *data = malloc(size); if (!data) fail(); read_all(plan, data, size);
  char extra; DWORD more = 0; BOOL trailing = ReadFile(plan, &extra, 1, &more, NULL);
  if (more || (!trailing && GetLastError() != ERROR_BROKEN_PIPE)) fail(); CloseHandle(plan);
  uint32_t args = integer(data + 4), incoming = integer(data + 8), at = 12;
  if (integer(data) != 1 || args > ITEMS || incoming > ITEMS) fail();
  wchar_t *executable = text(data, size, &at), *directory = text(data, size, &at);
  if (!*executable || !*directory) fail();
  wchar_t *command = calloc(32768, sizeof(wchar_t)); if (!command) fail(); size_t used = 0; argument(command, &used, executable);
  for (uint32_t i = 0; i < args; i++) { wchar_t *arg = text(data, size, &at); argument(command, &used, arg); erase(arg); }
  wchar_t *entries[ITEMS + 2] = {0}; uint32_t count = 0;
  for (uint32_t i = 0; i < incoming; i++) {
    wchar_t *entry = text(data, size, &at), *equals = wcschr(entry, L'=');
    if (!equals || equals == entry) fail();
    if ((argv[4][0] && !_wcsnicmp(entry, L"ZHIXING_TERMINAL_", 17)) ||
        same_key(entry, L"ZHIXING_TERMINAL_CREATE_PIPE") || same_key(entry, L"ZHIXING_TERMINAL_CREATE_TOKEN")) { erase(entry); continue; }
    size_t key = (size_t)(equals - entry); BOOL replaced = FALSE;
    for (uint32_t j = 0; j < count; j++) if (!_wcsnicmp(entries[j], entry, key) && entries[j][key] == L'=') {
      erase(entries[j]); entries[j] = entry; replaced = TRUE; break;
    }
    if (!replaced) entries[count++] = entry;
  }
  if (at != size) fail(); SecureZeroMemory(data, size); free(data);
  inherited_owner(entries, &count, L"ZHIXING_TERMINAL_CREATE_PIPE");
  inherited_owner(entries, &count, L"ZHIXING_TERMINAL_CREATE_TOKEN");
  qsort(entries, count, sizeof(wchar_t *), environment_order);
  size_t envSize = 1; for (uint32_t i = 0; i < count; i++) envSize += wcslen(entries[i]) + 1;
  wchar_t *environment = calloc(envSize, sizeof(wchar_t)); if (!environment) fail();
  size_t offset = 0; for (uint32_t i = 0; i < count; i++) {
    size_t n = wcslen(entries[i]) + 1; memcpy(environment + offset, entries[i], n * sizeof(wchar_t)); offset += n; erase(entries[i]);
  }
  if (argv[4][0]) {
    wchar_t name[256]; DWORD n = GetEnvironmentVariableW(L"ZHIXING_TERMINAL_WRITER_PIPE", name, 256);
    if (!n || n >= 256 || !endpoint_valid(name)) fail(); control = connect_pipe(name, FALSE);
  }
  HANDLE handles[3]; const char *kinds[] = {"input", "output", "error"};
  for (int i = 0; i < 3; i++) handles[i] = lane(argv[1], argv[2], kinds[i], TRUE);
  targetJob = CreateJobObjectW(NULL, NULL); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!targetJob || !SetInformationJobObject(targetJob, JobObjectExtendedLimitInformation, &limits, sizeof limits)) fail();
  SIZE_T attributeBytes = 0; InitializeProcThreadAttributeList(NULL, 2, 0, &attributeBytes);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = malloc(attributeBytes);
  if (!attributes || !InitializeProcThreadAttributeList(attributes, 2, 0, &attributeBytes) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof handles, NULL, NULL) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &targetJob, sizeof targetJob, NULL, NULL)) fail();
  STARTUPINFOEXW startup = {0}; PROCESS_INFORMATION child = {0}; startup.StartupInfo.cb = sizeof startup;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2]; startup.lpAttributeList = attributes;
  /* PowerShell initializes Console streams to Stream.Null under DETACHED_PROCESS,
   * even with valid inherited pipes. NO_WINDOW preserves redirected standard IO
   * without allocating a visible console or attaching to the user's terminal. */
  if (now_ms() >= deadline || !CreateProcessW(executable, command, NULL, NULL, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
      environment, directory, &startup.StartupInfo, &child)) fail();
  DeleteProcThreadAttributeList(attributes); free(attributes);
  erase(executable); erase(directory); erase(command); SecureZeroMemory(environment, envSize * sizeof(wchar_t)); free(environment);
  for (int i = 0; i < 3; i++) CloseHandle(handles[i]);
  char identity[180] = {0};
  if (argv[4][0]) {
    FILETIME born, exited, kernel, user; if (!GetProcessTimes(child.hProcess, &born, &exited, &kernel, &user)) fail();
    snprintf(identity, sizeof identity, "\"id\":\"%ls\",\"pid\":%lu,\"birth\":\"%llu\"", argv[4], child.dwProcessId,
      ((unsigned long long)born.dwHighDateTime << 32) | born.dwLowDateTime);
    char message[256], expected[256], received[256]; DWORD n = (DWORD)snprintf(message, sizeof message, "{\"type\":\"target\",%s}\n", identity);
    write_all(control, message, n);
    /* Canonical closed-protocol reply emitted by S, not a public JSON API. */
    int length = snprintf(expected, sizeof expected, "{\"type\":\"permit\",%s}\n", identity);
    read_all(control, received, (DWORD)length); if (memcmp(received, expected, (size_t)length)) fail();
  }
  if (now_ms() >= deadline || ResumeThread(child.hThread) != 1) fail(); CloseHandle(child.hThread);
  HANDLE watcher = NULL;
  if (argv[4][0]) {
    char message[256]; DWORD n = (DWORD)snprintf(message, sizeof message, "{\"type\":\"resumed\",%s}\n", identity); write_all(control, message, n);
    watcher = CreateThread(NULL, 0, watch_control, NULL, 0, NULL); if (!watcher) fail();
  }
  SetEvent(admitted); WaitForSingleObject(watchdog, INFINITE); CloseHandle(watchdog); CloseHandle(admitted);
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) fail();
  DWORD code; if (!GetExitCodeProcess(child.hProcess, &code)) fail();
  InterlockedExchange(&finishing, TRUE);
  /* Kill-on-close fences descendants even when the direct child exited first.
   * S still proves its entire Job empty before releasing this gate's account. */
  CloseHandle(targetJob); CloseHandle(child.hProcess);
  /* The gate ends here. ExitProcess closes the control handle and its blocked
   * reader atomically with process teardown; cancelling then joining a
   * synchronous reader races its first ReadFile and can hang normal exit. */
  ExitProcess(code);
}
