#include <wincrypt.h>

/* CurrentUser DPAPI, identical to ProtectedData(..., null, CurrentUser).
 * A finite copied input belongs to one N-API worker. No secret bytes enter
 * argv, stdout, exceptions, S, U, or any extra process. */
typedef struct {
  napi_async_work work; napi_deferred deferred;
  DATA_BLOB input, output; BOOL protect, succeeded;
} KeyWork;
static volatile LONG key_workers = 0;
static void key_dispose(KeyWork *work) {
  if (work->input.pbData) { SecureZeroMemory(work->input.pbData, work->input.cbData); free(work->input.pbData); }
  if (work->output.pbData) { SecureZeroMemory(work->output.pbData, work->output.cbData); LocalFree(work->output.pbData); }
  SecureZeroMemory(work, sizeof *work); free(work);
}
static void key_execute(napi_env env, void *data) {
  (void)env; KeyWork *work = data;
  work->succeeded = work->protect
    ? CryptProtectData(&work->input, NULL, NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &work->output)
    : CryptUnprotectData(&work->input, NULL, NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &work->output);
  if (work->output.cbData > 16384 || (!work->protect && work->output.cbData != 32)) work->succeeded = FALSE;
}
static void key_complete(napi_env env, napi_status status, void *data) {
  KeyWork *work = data; napi_value value, message;
  if (status == napi_ok && work->succeeded &&
      napi_create_buffer_copy(env, work->output.cbData, work->output.pbData, NULL, &value) == napi_ok) {
    napi_resolve_deferred(env, work->deferred, value);
  } else {
    napi_create_string_utf8(env, "terminal-credential-protection-failed", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &value); napi_reject_deferred(env, work->deferred, value);
  }
  napi_delete_async_work(env, work->work); key_dispose(work); InterlockedDecrement(&key_workers);
}
static napi_value protect_key(napi_env env, napi_callback_info info) {
  napi_value args[2], promise, name; size_t argc = 2, length = 0, modeLength = 0; char mode[16] = {0}; void *bytes = NULL; bool buffer = false;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || napi_get_value_string_utf8(env, args[0], mode, sizeof mode, &modeLength) != napi_ok ||
      modeLength != strlen(mode) || (strcmp(mode, "protect") && strcmp(mode, "unprotect")) ||
      napi_is_buffer(env, args[1], &buffer) != napi_ok || !buffer || napi_get_buffer_info(env, args[1], &bytes, &length) != napi_ok ||
      !length || length > 16384 || (!strcmp(mode, "protect") && length != 32)) {
    napi_throw_error(env, NULL, "terminal-credential-input-invalid"); return NULL;
  }
  KeyWork *work = calloc(1, sizeof *work);
  if (!work) { napi_throw_error(env, NULL, "terminal-credential-memory"); return NULL; }
  work->input.pbData = malloc(length); work->input.cbData = (DWORD)length; work->protect = !strcmp(mode, "protect");
  if (!work->input.pbData) { key_dispose(work); napi_throw_error(env, NULL, "terminal-credential-memory"); return NULL; }
  memcpy(work->input.pbData, bytes, length);
  if (InterlockedIncrement(&key_workers) > 4) {
    InterlockedDecrement(&key_workers); key_dispose(work); napi_throw_error(env, NULL, "terminal-credential-capacity"); return NULL;
  }
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "terminal-credential", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, key_execute, key_complete, work, &work->work) != napi_ok) {
    InterlockedDecrement(&key_workers); key_dispose(work); napi_throw_error(env, NULL, "terminal-credential-work-unavailable"); return NULL;
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    napi_delete_async_work(env, work->work); InterlockedDecrement(&key_workers); key_dispose(work); napi_throw_error(env, NULL, "terminal-credential-work-unavailable"); return NULL;
  }
  return promise;
}
