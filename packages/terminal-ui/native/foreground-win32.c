#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdbool.h>
#include <stdlib.h>
#include <wchar.h>
#include <string.h>
#include "credential-win32.h"

/* In-process creation edge of S. No domain data, terminal writes, process
   discovery, or supervision of S. A child cannot run before S admits its
   returned process handle. Creation never blocks S's JavaScript event loop. */
#define CHILDREN 32
#define TEXT_LIMIT 32767
typedef struct {
  HANDLE job, creator, process, primary, verifiedTarget;
  wchar_t *executable, *command, *environment, *directory;
  DWORD pid, error, identity;
  LONG occupied, cancelled, ready, resumed, finished;
  BOOL creatorObservedExited;
  char birth[32];
  BOOL console; DWORD scope;
  double queuedAt, queueMs, setupMs, createMs, publishMs, totalMs, readyAt;
} Child;
static Child children[CHILDREN];
static SRWLOCK lock = SRWLOCK_INIT;
static BOOL sealed = FALSE;
static DWORD generation = 0;
static HANDLE executionJob = NULL;

static double monotonic_ms(void) {
  LARGE_INTEGER counter, frequency;
  QueryPerformanceCounter(&counter); QueryPerformanceFrequency(&frequency);
  return (double)counter.QuadPart * 1000.0 / (double)frequency.QuadPart;
}

static void free_arguments(Child *child) {
  free(child->executable); free(child->command);
  free(child->environment); free(child->directory);
  child->executable = child->command = child->environment = child->directory = NULL;
}
static DWORD WINAPI create_child(void *opaque) {
  Child *child = opaque;
  const double beganAt = monotonic_ms();
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = malloc(bytes);
  BOOL initialized = attributes && InitializeProcThreadAttributeList(attributes, 2, 0, &bytes);
  HANDLE nullHandle = INVALID_HANDLE_VALUE;
  HANDLE inherited[3] = {0}; DWORD inheritedCount = 0;
  STARTUPINFOEXW startup = {0}; PROCESS_INFORMATION process = {0};
  startup.StartupInfo.cb = sizeof startup;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.lpAttributeList = attributes;
  DWORD error = initialized ? 0 : GetLastError();
  HANDLE jobs[2] = { child->scope == 1 ? executionJob : child->job, child->job };
  if (!error && child->job && !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
      jobs, sizeof(HANDLE) * (child->scope == 1 ? 2 : 1), NULL, NULL)) error = GetLastError();
  if (!error) {
    if (child->console) {
      const DWORD kinds[] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
      for (int i = 0; i < 3 && !error; i++) {
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(kinds[i]), GetCurrentProcess(), &inherited[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) error = GetLastError();
        else inheritedCount++;
      }
      startup.StartupInfo.hStdInput = inherited[0];
      startup.StartupInfo.hStdOutput = inherited[1];
      startup.StartupInfo.hStdError = inherited[2];
    } else {
      SECURITY_ATTRIBUTES security = { sizeof security, NULL, TRUE };
      nullHandle = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, NULL);
      if (nullHandle == INVALID_HANDLE_VALUE) error = GetLastError();
      startup.StartupInfo.hStdInput = startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = nullHandle;
      if (!error) { inherited[0] = nullHandle; inheritedCount = 1; }
    }
  }
  if (!error && !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited, inheritedCount * sizeof(HANDLE), NULL, NULL)) error = GetLastError();
  /* Cancellation can precede or overlap CreateProcess. Even in the latter
     case the initial thread is suspended and the job membership is atomic. */
  if (!error && InterlockedCompareExchange(&child->cancelled, 0, 0)) error = ERROR_CANCELLED;
  const double createAt = monotonic_ms();
  if (!error && !CreateProcessW(child->executable, child->command, NULL, NULL, TRUE,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | (child->scope == 2 ? DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP : 0),
      child->environment, child->directory, &startup.StartupInfo, &process)) error = GetLastError();
  const double createdAt = monotonic_ms();
  if (initialized) DeleteProcThreadAttributeList(attributes);
  free(attributes);
  for (DWORD i = 0; i < inheritedCount; i++) CloseHandle(inherited[i]);
  AcquireSRWLockExclusive(&lock);
  child->queueMs = beganAt - child->queuedAt;
  child->setupMs = createAt - beganAt;
  child->createMs = createdAt - createAt;
  child->error = error;
  if (!error) {
    child->process = process.hProcess; child->primary = process.hThread; child->pid = process.dwProcessId;
    if (sealed || child->cancelled) { child->cancelled = TRUE; TerminateProcess(child->process, ERROR_CANCELLED); }
  }
  free_arguments(child);
  child->readyAt = monotonic_ms();
  child->publishMs = child->readyAt - createdAt;
  child->totalMs = child->readyAt - child->queuedAt;
  child->ready = TRUE;
  ReleaseSRWLockExclusive(&lock);
  InterlockedExchange(&child->finished, TRUE);
  return 0;
}

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message); return NULL;
}
static napi_value undefined(napi_env env) { napi_value result; napi_get_undefined(env, &result); return result; }
static wchar_t *text(napi_env env, napi_value value, BOOL block) {
  size_t length = 0, written = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok || !length || length > TEXT_LIMIT) return NULL;
  wchar_t *result = calloc(length + 2, sizeof(wchar_t));
  if (!result || napi_get_value_string_utf16(env, value, (char16_t *)result, length + 1, &written) != napi_ok || written != length) { free(result); return NULL; }
  if ((!block && wcslen(result) != length) || (block && (length < 2 || result[length - 1] || result[length - 2]))) { free(result); return NULL; }
  return result;
}
static Child *argument_child(napi_env env, napi_callback_info info) {
  napi_value value; size_t count = 1; uint32_t id = 0;
  if (napi_get_cb_info(env, info, &count, &value, NULL, NULL) != napi_ok || count != 1 || napi_get_value_uint32(env, value, &id) != napi_ok || !id || !children[id % CHILDREN].occupied || children[id % CHILDREN].identity != id) {
    fail(env, "terminal-native-child-identity"); return NULL;
  }
  return &children[id % CHILDREN];
}
static napi_value create(napi_env env, napi_callback_info info) {
  napi_value args[6], result; size_t count = 6; bool console = false; uint32_t scope = 1;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || (count != 5 && count != 6) ||
      napi_get_value_bool(env, args[4], &console) != napi_ok) return fail(env, "terminal-native-create-arguments");
  if (count == 6 && (napi_get_value_uint32(env, args[5], &scope) != napi_ok || scope > 2)) return fail(env, "terminal-native-create-scope");
  AcquireSRWLockExclusive(&lock);
  int id = 0; while (id < CHILDREN && children[id].occupied) id++;
  if (sealed || id == CHILDREN || generation >= 0x07FFFFFF) { ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-admission-closed"); }
  Child *child = &children[id]; ZeroMemory(child, sizeof *child); child->occupied = TRUE; child->console = console; child->scope = scope;
  child->identity = ++generation * CHILDREN + id;
  child->executable = text(env, args[0], FALSE); child->command = text(env, args[1], FALSE);
  child->environment = text(env, args[2], TRUE); child->directory = text(env, args[3], FALSE);
  child->job = scope == 2 ? NULL : CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  /* No execution descendant may break away. R has a separate job; an
     admitted independent Host is born outside both jobs. */
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!child->executable || !child->command || !child->environment || !child->directory || (scope != 2 && !child->job) ||
      (scope != 2 && !SetInformationJobObject(child->job, JobObjectExtendedLimitInformation, &limits, sizeof limits))) {
    free_arguments(child); if (child->job) CloseHandle(child->job); ZeroMemory(child, sizeof *child);
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-create-preflight");
  }
  child->queuedAt = monotonic_ms();
  child->creator = CreateThread(NULL, 0, create_child, child, 0, NULL);
  if (!child->creator) { free_arguments(child); if (child->job) CloseHandle(child->job); ZeroMemory(child, sizeof *child); ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-create-thread"); }
  ReleaseSRWLockExclusive(&lock);
  napi_create_uint32(env, child->identity, &result); return result;
}
static napi_value resume(napi_env env, napi_callback_info info) {
  Child *child = argument_child(env, info); if (!child) return NULL;
  AcquireSRWLockExclusive(&lock);
  BOOL allowed = !sealed && !child->cancelled && child->ready && child->process && !child->resumed;
  if (allowed && ResumeThread(child->primary) == 1) child->resumed = TRUE;
  else allowed = FALSE;
  ReleaseSRWLockExclusive(&lock);
  if (!allowed) return fail(env, "terminal-native-resume-denied");
  return undefined(env);
}
static napi_value stop(napi_env env, napi_callback_info info) {
  Child *child = argument_child(env, info); if (!child) return NULL;
  AcquireSRWLockExclusive(&lock);
  child->cancelled = TRUE;
  if (child->job && !TerminateJobObject(child->job, ERROR_CANCELLED)) {
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-branch-terminate-failed");
  }
  if (!child->job && child->process && WaitForSingleObject(child->process, 0) == WAIT_TIMEOUT && !TerminateProcess(child->process, ERROR_CANCELLED)) {
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-terminate-failed");
  }
  ReleaseSRWLockExclusive(&lock); return undefined(env);
}
static void number(napi_env env, napi_value object, const char *name, DWORD value) {
  napi_value property; napi_create_uint32(env, value, &property); napi_set_named_property(env, object, name, property);
}
static void boolean(napi_env env, napi_value object, const char *name, BOOL value) {
  napi_value property; napi_get_boolean(env, !!value, &property); napi_set_named_property(env, object, name, property);
}
static void duration(napi_env env, napi_value object, const char *name, double value) {
  napi_value property; napi_create_double(env, value, &property); napi_set_named_property(env, object, name, property);
}
/* S verifies the private gate's metadata against its own Job and a real held
   target handle before publishing the writer identity. A PID string alone is
   never a receipt, and a ticket can bind only one actual target. */
static napi_value verify_target(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; uint32_t id = 0, pid = 0;
  char expected[32] = {0}; size_t length = 0, written = 0;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3 ||
      napi_get_value_uint32(env, args[0], &id) != napi_ok || !id ||
      napi_get_value_uint32(env, args[1], &pid) != napi_ok || !pid ||
      napi_get_value_string_utf8(env, args[2], NULL, 0, &length) != napi_ok || !length || length >= sizeof expected ||
      napi_get_value_string_utf8(env, args[2], expected, sizeof expected, &written) != napi_ok || written != length) return fail(env, "terminal-target-identity");
  AcquireSRWLockExclusive(&lock);
  Child *gate = &children[id % CHILDREN];
  if (sealed || !gate->occupied || gate->identity != id || gate->cancelled || !gate->resumed ||
      !gate->job || !gate->process || gate->pid == pid || WaitForSingleObject(gate->process, 0) != WAIT_TIMEOUT) {
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-target-gate-unavailable");
  }
  HANDLE target = gate->verifiedTarget;
  BOOL newlyOpened = !target;
  if (!target) target = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  BOOL inJob = FALSE; FILETIME born, end, kernel, user; char birth[32] = {0};
  BOOL valid = target && GetProcessId(target) == pid && WaitForSingleObject(target, 0) == WAIT_TIMEOUT &&
    IsProcessInJob(target, gate->job, &inJob) && inJob && GetProcessTimes(target, &born, &end, &kernel, &user);
  if (valid) {
    snprintf(birth, sizeof birth, "%llu", ((unsigned long long)born.dwHighDateTime << 32) | born.dwLowDateTime);
    valid = strcmp(birth, expected) == 0;
  }
  if (!valid) {
    if (newlyOpened && target) CloseHandle(target);
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-target-not-owned");
  }
  gate->verifiedTarget = target;
  ReleaseSRWLockExclusive(&lock);
  napi_value result, value; napi_create_object(env, &result); number(env, result, "pid", pid);
  napi_create_string_utf8(env, birth, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "birth", value);
  return result;
}
static napi_value snapshot_state(napi_env env, napi_callback_info info, BOOL inventory) {
  Child *child = argument_child(env, info); if (!child) return NULL;
  napi_value result; napi_create_object(env, &result);
  AcquireSRWLockExclusive(&lock);
  boolean(env, result, "ready", child->ready); boolean(env, result, "created", child->process != NULL);
  if (child->ready) {
    duration(env, result, "nativeQueueMs", child->queueMs);
    duration(env, result, "nativeSetupMs", child->setupMs);
    duration(env, result, "nativeCreateMs", child->createMs);
    duration(env, result, "nativePublishMs", child->publishMs);
    duration(env, result, "nativeTotalMs", child->totalMs);
    duration(env, result, "observationMs", monotonic_ms() - child->readyAt);
  }
  boolean(env, result, "resumed", child->resumed); boolean(env, result, "cancelled", child->cancelled);
  if (!child->creatorObservedExited && child->creator && WaitForSingleObject(child->creator, 0) == WAIT_OBJECT_0) child->creatorObservedExited = TRUE;
  boolean(env, result, "creationExited", child->creatorObservedExited);
  BOOL exited = child->process && WaitForSingleObject(child->process, 0) == WAIT_OBJECT_0;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION branch = {0};
  /* Stable live roots need only an exit observation. Exact descendant counts
     remain mandatory for every exit/cancellation and for explicit snapshots. */
  if (inventory || exited || child->cancelled || !child->process) {
    if (child->job && !QueryInformationJobObject(child->job, JobObjectBasicAccountingInformation, &branch, sizeof branch, NULL)) {
      ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-branch-query-failed");
    }
    number(env, result, "branchActive", branch.ActiveProcesses);
  }
  number(env, result, "pid", child->pid); number(env, result, "error", child->error);
  boolean(env, result, "exited", exited);
  DWORD code = 0; if (exited && GetExitCodeProcess(child->process, &code)) number(env, result, "exitCode", code);
  if (child->process && !child->birth[0]) {
    FILETIME born, end, kernel, user;
    if (GetProcessTimes(child->process, &born, &end, &kernel, &user)) {
      snprintf(child->birth, sizeof child->birth, "%llu", ((unsigned long long)born.dwHighDateTime << 32) | born.dwLowDateTime);
    }
  }
  if (child->birth[0]) {
    napi_value value; napi_create_string_utf8(env, child->birth, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "birth", value);
  }
  ReleaseSRWLockExclusive(&lock); return result;
}
static napi_value snapshot(napi_env env, napi_callback_info info) { return snapshot_state(env, info, TRUE); }
static napi_value observe(napi_env env, napi_callback_info info) { return snapshot_state(env, info, FALSE); }
static napi_value seal(napi_env env, napi_callback_info info) {
  (void)info; AcquireSRWLockExclusive(&lock); sealed = TRUE;
  for (int i = 0; i < CHILDREN; i++) if (children[i].occupied && !children[i].resumed) {
    children[i].cancelled = TRUE; if (children[i].process) TerminateProcess(children[i].process, ERROR_CANCELLED);
  }
  ReleaseSRWLockExclusive(&lock); return undefined(env);
}
static napi_value release(napi_env env, napi_callback_info info) {
  Child *child = argument_child(env, info); if (!child) return NULL;
  AcquireSRWLockExclusive(&lock);
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION branch = {0};
  if (child->job && (!QueryInformationJobObject(child->job, JobObjectBasicAccountingInformation, &branch, sizeof branch, NULL) || branch.ActiveProcesses)) {
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-branch-not-reaped");
  }
  if (!child->finished || WaitForSingleObject(child->creator, 0) != WAIT_OBJECT_0 ||
      (child->process && WaitForSingleObject(child->process, 0) != WAIT_OBJECT_0)) {
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-native-child-not-reaped");
  }
  if (child->primary) CloseHandle(child->primary);
  if (child->process) CloseHandle(child->process);
  if (child->verifiedTarget) CloseHandle(child->verifiedTarget);
  CloseHandle(child->creator); if (child->job) CloseHandle(child->job); ZeroMemory(child, sizeof *child);
  ReleaseSRWLockExclusive(&lock); return undefined(env);
}
#include "writer-declaration-win32.h"
static void cleanup(void *unused) {
  declaration_close();
  (void)unused; AcquireSRWLockExclusive(&lock); sealed = TRUE;
  for (int i = 0; i < CHILDREN; i++) if (children[i].occupied) {
    children[i].cancelled = TRUE;
    if (children[i].process && !(children[i].scope == 2 && children[i].resumed)) TerminateProcess(children[i].process, ERROR_CANCELLED);
    /* A creator still owns its slot and job until it returns. The enclosing
       process releases those OS handles on exit; never free under its thread. */
  }
  ReleaseSRWLockExclusive(&lock);
  if (executionJob) CloseHandle(executionJob);
}
static napi_value execution_state(napi_env env, napi_callback_info info) {
  (void)info; JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
  if (!QueryInformationJobObject(executionJob, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) return fail(env, "terminal-execution-query-failed");
  napi_value result; napi_create_object(env, &result); number(env, result, "active", accounting.ActiveProcesses);
  DWORD pending = 0;
  AcquireSRWLockShared(&lock);
  for (int i = 0; i < CHILDREN; i++) if (children[i].occupied && WaitForSingleObject(children[i].creator, 0) != WAIT_OBJECT_0) pending++;
  ReleaseSRWLockShared(&lock); number(env, result, "creating", pending); return result;
}
static napi_value terminate_execution(napi_env env, napi_callback_info info) {
  (void)info; if (!TerminateJobObject(executionJob, ERROR_CANCELLED)) return fail(env, "terminal-execution-terminate-failed");
  return undefined(env);
}
static napi_value detach(napi_env env, napi_callback_info info) {
  Child *child = argument_child(env, info); if (!child) return NULL;
  AcquireSRWLockExclusive(&lock);
  if (child->scope != 2 || !child->resumed || !child->finished || WaitForSingleObject(child->creator, 0) != WAIT_OBJECT_0) {
    ReleaseSRWLockExclusive(&lock); return fail(env, "terminal-host-not-independent");
  }
  CloseHandle(child->primary); CloseHandle(child->process); CloseHandle(child->creator); ZeroMemory(child, sizeof *child);
  ReleaseSRWLockExclusive(&lock); return undefined(env);
}
/* Read-only identity adapter for FileLock. Match its persisted .NET UTC ticks,
   not the FILETIME representation used by the private terminal protocol. */
static napi_value process_identity(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1], result, value; double requested = 0;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  const char *kind = "unknown"; char birth[48] = {0};
  if (argc == 1 && napi_get_value_double(env, args[0], &requested) == napi_ok &&
      requested >= 1 && requested <= 4294967295.0 && requested == (double)(DWORD)requested) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)requested);
    if (!process) { if (GetLastError() == ERROR_INVALID_PARAMETER) kind = "absent"; }
    else {
      FILETIME created, ended, kernel, user;
      if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) kind = "absent";
      else if (GetProcessTimes(process, &created, &ended, &kernel, &user)) {
        unsigned long long ticks = (((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime) + 504911232000000000ULL;
        snprintf(birth, sizeof birth, "win32:%llu", ticks); kind = "present";
      }
      CloseHandle(process);
    }
  }
  napi_create_object(env, &result);
  napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "kind", value);
  if (birth[0]) { napi_create_string_utf8(env, birth, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "birth", value); }
  return result;
}
/* A short-lived helper publishes an eager CF_UNICODETEXT allocation. The OS,
   not this process, owns its lifetime after SetClipboardData succeeds. */
static napi_value clipboard_write(napi_env env, napi_callback_info info) {
  size_t argc=1, length=0; napi_value args[1], result;
  napi_get_cb_info(env,info,&argc,args,NULL,NULL);
  if(argc!=1||napi_get_value_string_utf16(env,args[0],NULL,0,&length)!=napi_ok||length>224*1024) return fail(env,"terminal-clipboard-size");
  const char *status="unavailable";
  HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
  WCHAR currentName[256], inputName[256]; DWORD needed=0;
  BOOL desktop=input&&GetUserObjectInformationW(input,UOI_NAME,inputName,sizeof inputName,&needed)&&
    GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()),UOI_NAME,currentName,sizeof currentName,&needed)&&!wcscmp(inputName,currentName);
  if(input)CloseDesktop(input);
  if(desktop){
    HWND window=CreateWindowExW(0,L"STATIC",L"",0,0,0,0,0,HWND_MESSAGE,NULL,GetModuleHandleW(NULL),NULL);
    HGLOBAL allocation=GlobalAlloc(GMEM_MOVEABLE,(length+1)*sizeof(WCHAR));
    WCHAR *text=allocation?GlobalLock(allocation):NULL;
    if(text){
      size_t copied=0;napi_get_value_string_utf16(env,args[0],(char16_t*)text,length+1,&copied);
      BOOL valid=copied==length&&wcslen(text)==length;GlobalUnlock(allocation);
      if(valid&&window&&OpenClipboard(window)){
        if(EmptyClipboard()){
          status="unknown";
          if(SetClipboardData(CF_UNICODETEXT,allocation)){allocation=NULL;status="accepted";}
        }
        CloseClipboard();
      }
    }
    if(allocation)GlobalFree(allocation);
    if(window)DestroyWindow(window);
  }
  napi_create_string_utf8(env,status,NAPI_AUTO_LENGTH,&result);return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  executionJob = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!executionJob || !SetInformationJobObject(executionJob, JobObjectExtendedLimitInformation, &limits, sizeof limits)) return fail(env, "terminal-execution-job-unavailable");
  napi_property_descriptor methods[] = {
    { "writeClipboard", NULL, clipboard_write, NULL, NULL, NULL, napi_default, NULL },
    { "protectKey", NULL, protect_key, NULL, NULL, NULL, napi_default, NULL },
    { "processIdentity", NULL, process_identity, NULL, NULL, NULL, napi_default, NULL },
    { "declareWriter", NULL, declare_writer, NULL, NULL, NULL, napi_default, NULL },
    { "closeWriterDeclaration", NULL, close_writer_declaration, NULL, NULL, NULL, napi_default, NULL },
    { "create", NULL, create, NULL, NULL, NULL, napi_default, NULL },
    { "verifyTarget", NULL, verify_target, NULL, NULL, NULL, napi_default, NULL },
    { "resume", NULL, resume, NULL, NULL, NULL, napi_default, NULL },
    { "stop", NULL, stop, NULL, NULL, NULL, napi_default, NULL },
    { "snapshot", NULL, snapshot, NULL, NULL, NULL, napi_default, NULL },
    { "observe", NULL, observe, NULL, NULL, NULL, napi_default, NULL },
    { "seal", NULL, seal, NULL, NULL, NULL, napi_default, NULL },
    { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL },
    { "executionState", NULL, execution_state, NULL, NULL, NULL, napi_default, NULL },
    { "terminateExecution", NULL, terminate_execution, NULL, NULL, NULL, napi_default, NULL },
    { "detach", NULL, detach, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof methods / sizeof methods[0], methods);
  napi_add_env_cleanup_hook(env, cleanup, NULL); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
