/* Fixed, memory-only log protocol proof. The OS pipe peer remains this process;
   no caller-supplied path, file data, callback, or product state enters it. */
#define DECLARATION_CLIENTS 8
typedef struct { HANDLE pipe; OVERLAPPED io; DWORD state; ULONGLONG deadline; char byte; } DeclarationClient;
static struct {
  HANDLE stop, thread;
  DeclarationClient clients[DECLARATION_CLIENTS];
  char response[192]; DWORD bytes;
} declaration;

static void declaration_connect(DeclarationClient *client, BOOL recycle) {
  /* The first client can connect between CreateNamedPipe and this thread's
     first turn. Only an already served instance may be disconnected. */
  if (recycle) DisconnectNamedPipe(client->pipe);
  ResetEvent(client->io.hEvent);
  client->state = 0; client->deadline = 0;
  if (ConnectNamedPipe(client->pipe, &client->io) || GetLastError() == ERROR_PIPE_CONNECTED) SetEvent(client->io.hEvent);
  else if (GetLastError() != ERROR_IO_PENDING) { client->state = 3; SetEvent(client->io.hEvent); }
}
static DWORD WINAPI declaration_serve(void *unused) {
  (void)unused;
  HANDLE events[DECLARATION_CLIENTS + 1]; events[0] = declaration.stop;
  for (int i = 0; i < DECLARATION_CLIENTS; i++) { events[i + 1] = declaration.clients[i].io.hEvent; declaration_connect(&declaration.clients[i], FALSE); }
  for (;;) {
    DWORD timeout = INFINITE;
    ULONGLONG now = GetTickCount64();
    for (int i = 0; i < DECLARATION_CLIENTS; i++) {
      DeclarationClient *client = &declaration.clients[i];
      if (client->deadline) { DWORD left = client->deadline > now ? (DWORD)(client->deadline - now) : 0; if (left < timeout) timeout = left; }
    }
    DWORD selected = WaitForMultipleObjects(DECLARATION_CLIENTS + 1, events, FALSE, timeout);
    if (selected == WAIT_OBJECT_0 || selected == WAIT_FAILED) break;
    now = GetTickCount64();
    for (int i = 0; i < DECLARATION_CLIENTS; i++) {
      DeclarationClient *client = &declaration.clients[i]; DWORD bytes = 0;
      if (client->deadline && now >= client->deadline) {
        CancelIoEx(client->pipe, &client->io); GetOverlappedResult(client->pipe, &client->io, &bytes, TRUE);
        declaration_connect(client, TRUE); continue;
      }
      if (selected != WAIT_OBJECT_0 + i + 1) continue;
      if (client->state == 3) goto end; /* Failed server, never spin on an invalid handle. */
      if (client->state == 0) {
        client->deadline = now + 500; client->state = 1; ResetEvent(client->io.hEvent);
        if (WriteFile(client->pipe, declaration.response, declaration.bytes, &bytes, &client->io)) SetEvent(client->io.hEvent);
        else if (GetLastError() != ERROR_IO_PENDING) declaration_connect(client, TRUE);
      } else if (client->state == 1) {
        if (!GetOverlappedResult(client->pipe, &client->io, &bytes, FALSE) || bytes != declaration.bytes) { declaration_connect(client, TRUE); continue; }
        /* A disconnect would discard unread bytes. Wait asynchronously for the
           client to close instead, under the original 500 ms deadline. */
        client->state = 2; ResetEvent(client->io.hEvent);
        if (ReadFile(client->pipe, &client->byte, 1, &bytes, &client->io)) declaration_connect(client, TRUE);
        else if (GetLastError() != ERROR_IO_PENDING) declaration_connect(client, TRUE);
      } else declaration_connect(client, TRUE);
    }
  }
end:
  for (int i = 0; i < DECLARATION_CLIENTS; i++) {
    DeclarationClient *client = &declaration.clients[i]; DWORD bytes;
    CancelIoEx(client->pipe, &client->io); GetOverlappedResult(client->pipe, &client->io, &bytes, TRUE);
    DisconnectNamedPipe(client->pipe);
  }
  return 0;
}
static void declaration_close(void) {
  if (declaration.stop) SetEvent(declaration.stop);
  if (declaration.thread) { WaitForSingleObject(declaration.thread, INFINITE); CloseHandle(declaration.thread); }
  for (int i = 0; i < DECLARATION_CLIENTS; i++) {
    if (declaration.clients[i].pipe && declaration.clients[i].pipe != INVALID_HANDLE_VALUE) CloseHandle(declaration.clients[i].pipe);
    if (declaration.clients[i].io.hEvent) CloseHandle(declaration.clients[i].io.hEvent);
  }
  if (declaration.stop) CloseHandle(declaration.stop);
  ZeroMemory(&declaration, sizeof declaration);
}
static napi_value declare_writer(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2, size = 0; char root[65]; uint32_t protocol = 0;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (declaration.stop || count != 2 || napi_get_value_string_utf8(env, args[0], NULL, 0, &size) != napi_ok || size != 64 ||
      napi_get_value_string_utf8(env, args[0], root, sizeof root, &size) != napi_ok ||
      napi_get_value_uint32(env, args[1], &protocol) != napi_ok || protocol != 2) return fail(env, "terminal-writer-declaration-invalid");
  for (size_t i = 0; i < 64; i++) if (!((root[i] >= 'a' && root[i] <= 'f') || (root[i] >= '0' && root[i] <= '9'))) return fail(env, "terminal-writer-declaration-invalid");
  wchar_t endpoint[96]; _snwprintf(endpoint, 96, L"\\\\.\\pipe\\zhixing-log-v%u-%lu", protocol, GetCurrentProcessId());
  declaration.bytes = (DWORD)snprintf(declaration.response, sizeof declaration.response,
    "{\"protocol\":%u,\"root\":\"%s\",\"pid\":%lu}\n", protocol, root, GetCurrentProcessId());
  declaration.stop = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!declaration.stop) goto failed;
  for (int i = 0; i < DECLARATION_CLIENTS; i++) {
    DeclarationClient *client = &declaration.clients[i];
    client->io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    client->pipe = CreateNamedPipeW(endpoint, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (i == 0 ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, DECLARATION_CLIENTS, 512, 1, 500, NULL);
    if (!client->io.hEvent || client->pipe == INVALID_HANDLE_VALUE) goto failed;
  }
  declaration.thread = CreateThread(NULL, 64 * 1024, declaration_serve, NULL, STACK_SIZE_PARAM_IS_A_RESERVATION, NULL);
  if (!declaration.thread) goto failed;
  return undefined(env);
failed:
  declaration_close(); return fail(env, "terminal-writer-declaration-unavailable");
}
static napi_value close_writer_declaration(napi_env env, napi_callback_info info) {
  (void)info; declaration_close(); return undefined(env);
}
