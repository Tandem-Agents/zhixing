using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class CheckpointChildBridge {
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
  const uint FILE_LIST_DIRECTORY = 0x0001, FILE_ADD_FILE = 0x0002, FILE_ADD_SUBDIRECTORY = 0x0004;
  const uint FILE_READ_DATA = 0x0001, FILE_WRITE_DATA = 0x0002, FILE_APPEND_DATA = 0x0004;
  const uint FILE_READ_ATTRIBUTES = 0x0080, DELETE = 0x00010000, SYNCHRONIZE = 0x00100000;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_OPEN = 1, FILE_CREATE = 2, FILE_OPEN_IF = 3;
  const uint FILE_DIRECTORY_FILE = 1, FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_NON_DIRECTORY_FILE = 0x40, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint OBJ_CASE_INSENSITIVE = 0x40, OBJ_DONT_REPARSE = 0x1000;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const int FileRenameInfo = 3, FileDispositionInfo = 4, FileIdBothDirectoryInfo = 10, FileIdBothDirectoryRestartInfo = 11;

  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct FILE_DISPOSITION_INFO { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint capacity, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetDiskFreeSpaceExW(string directory, out ulong available, out ulong total, out ulong free);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushFileBuffers(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct OVERLAPPED { public IntPtr Internal, InternalHigh; public uint Offset, OffsetHigh; public IntPtr Event; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool LockFileEx(IntPtr handle, uint flags, uint reserved, uint low, uint high, ref OVERLAPPED overlapped);
  [DllImport("kernel32.dll", EntryPoint = "LockFileEx", SetLastError = true)] static extern bool QueueLockFile(IntPtr handle, uint flags, uint reserved, uint low, uint high, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateEventW(IntPtr security, bool manualReset, bool initialState, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CancelIoEx(IntPtr handle, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetOverlappedResult(IntPtr handle, IntPtr overlapped, out uint transferred, bool wait);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int cls, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(IntPtr handle, int cls, IntPtr info, uint size);
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out IntPtr handle, uint access, ref OBJECT_ATTRIBUTES attributes, out IO_STATUS_BLOCK status,
    IntPtr allocationSize, uint fileAttributes, uint share, uint disposition, uint options, IntPtr eaBuffer, uint eaLength);
  [DllImport("ntdll.dll")]
  static extern int NtSetInformationFile(IntPtr handle, out IO_STATUS_BLOCK status, IntPtr information, uint length, int informationClass);

  static readonly Dictionary<long, IntPtr> Handles = new Dictionary<long, IntPtr>();
  [DllImport("shell32.dll", SetLastError = true)]
  static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32 {
    public uint Size, Usage, ProcessId;
    public IntPtr DefaultHeap;
    public uint ModuleId, Threads, ParentProcessId;
    public int BasePriority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Executable;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr buffer, int length, out int required);
  static long NextHandle = 1;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
  // Opt-in disposable display owner only. Denying delete sharing pins the
  // name while retained; every use still checks size, identity and link count.
  // Four handles suffice for data/index plus their finite replacement work.
  static readonly Dictionary<string, IntPtr> PinnedWrites = new Dictionary<string, IntPtr>();
  static void ClosePinnedWrites() {
    foreach (var file in PinnedWrites.Values) CloseHandle(file);
    PinnedWrites.Clear();
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
  static Stream StandardPipe(int kind, FileAccess access) {
    var handle = GetStdHandle(kind);
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new InvalidOperationException("Checkpoint standard pipe missing");
    // GUI-subsystem helpers have no console. Adopt only the redirected handles
    // explicitly supplied by the owner; Console.OpenStandard* can return Null.
    return new FileStream(new SafeFileHandle(handle, false), access, 4096, false);
  }
  static int Main() {
    // No GUI/error dialog on an invalid bootstrap or a disconnected owner.
    try { Run(); return 0; } catch { return 71; }
  }
  static void Run() {
    // Private pipes are UTF-8 streams, not a console. Setting Console's code
    // page requires a console even when all I/O is redirected, and breaks a
    // correctly detached foreground helper before it can read its first call.
    // Only the containing foreground owner supplies this fixed private pipe.
    // Ordinary checkpoint/logging owners retain their existing stdio protocol.
    var endpoint = Environment.GetEnvironmentVariable("ZHIXING_CHECKPOINT_PIPE");
    NamedPipeClientStream transport = null;
    if (endpoint != null) {
      const string prefix = "\\\\.\\pipe\\zhixing-terminal-";
      if (!endpoint.StartsWith(prefix, StringComparison.Ordinal) || endpoint.Length > 160) throw new InvalidOperationException("Invalid filesystem owner pipe");
      transport = new NamedPipeClientStream(".", endpoint.Substring(9), PipeDirection.InOut);
      transport.Connect(5000);
    }
    var input = new BufferedStream(transport != null ? (Stream)transport : StandardPipe(-10, FileAccess.Read), 64 * 1024);
    Console.SetOut(new StreamWriter(transport != null ? (Stream)transport : StandardPipe(-11, FileAccess.Write), new UTF8Encoding(false), 4096, true) { AutoFlush = true });
    for (;;) {
      Dictionary<string, object> request = null;
      try {
        request = ReadRequest(input);
        if (request == null) break;
        var value = Dispatch(request);
        Reply(request, true, value, null);
      } catch (Exception error) {
        var native = error as System.ComponentModel.Win32Exception;
        Reply(request, false, null, native == null ? error.Message : error.Message + " (Win32 " + native.NativeErrorCode + ")");
        // A malformed/truncated frame has no trustworthy next boundary. End
        // this owner; never reinterpret leftover file bytes as another request.
        if (request == null) break;
      }
    }
    ClosePinnedWrites();
    foreach (var handle in Handles.Values) CloseHandle(handle);
    input.Dispose();
  }

  static Dictionary<string, object> ReadRequest(Stream input) {
    const int maximum = 8 * 1024 * 1024;
    using (var header = new MemoryStream()) {
      for (;;) {
        int next = input.ReadByte();
        if (next < 0) { if (header.Length == 0) return null; throw new EndOfStreamException("Checkpoint header is truncated"); }
        if (next == 10) break;
        if (header.Length >= maximum) throw new InvalidOperationException("Checkpoint request exceeds its bound");
        header.WriteByte((byte)next);
      }
      var request = Json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(header.GetBuffer(), 0, (int)header.Length));
      if (request.ContainsKey("dataBytes")) {
        var op = Text(request, "op");
        if (!(request["dataBytes"] is int)) throw new InvalidOperationException("Invalid checkpoint binary length");
        long length = (int)request["dataBytes"];
        if (request.ContainsKey("data") || (op != "writeAt" && op != "writeFile" && op != "writeRange") ||
            length < 0 || length + header.Length + 1 > maximum) throw new InvalidOperationException("Invalid checkpoint binary range");
        var data = new byte[(int)length];
        for (int offset = 0; offset < data.Length;) {
          int count = input.Read(data, offset, data.Length - offset);
          if (count == 0) throw new EndOfStreamException("Checkpoint binary range is truncated");
          offset += count;
        }
        request["data"] = data;
      }
      return request;
    }
  }

  static byte[] RequestBytes(Dictionary<string, object> r) {
    var binary = r["data"] as byte[];
    return binary ?? Convert.FromBase64String(Text(r, "data"));
  }

  static object Dispatch(Dictionary<string, object> r) {
    var op = Text(r, "op");
    // Explicit mutations/close release pins before operating on their names.
    if (op == "unlinkEntry" || op == "renameEntry" || op == "close" || op == "truncateFile" || op == "writeFile" || op == "writeRange" || op == "copyRange") ClosePinnedWrites();
    if (op == "observeNodeProcesses") return ObserveNodeProcesses();
    if (op == "readLocalProcessDeclaration") return ReadLocalProcessDeclaration(Text(r, "endpoint"), Number(r, "pid"));
    if (op == "openPath") return Register(OpenPath(Text(r, "path"), Flag(r, "create"), r.ContainsKey("readOnly") && Flag(r, "readOnly")));
    if (op == "statFile") return StatFile(Get(r, "parent"), Text(r, "name"));
    if (op == "statEntry") return StatEntry(Get(r, "parent"), Text(r, "name"));
    if (op == "availableDiskBytes") return AvailableDiskBytes(Get(r, "handle"));
    if (op == "writeAt") return WriteAt(Get(r, "parent"), Text(r, "name"), Number(r, "maximumBytes"), Number(r, "offset"), RequestBytes(r), r.ContainsKey("identity") ? Text(r, "identity") : null, r.ContainsKey("pin") && Flag(r, "pin"));
    if (op == "copyRange") return CopyRange(Get(r, "parent"), Text(r, "source"), Text(r, "sourceIdentity"), Number(r, "sourceBytes"), Number(r, "sourceOffset"), Text(r, "target"), r.ContainsKey("targetIdentity") ? Text(r, "targetIdentity") : null, Number(r, "targetOffset"), Number(r, "length"));
    if (op == "statFiles") {
      var names = r["names"] as System.Collections.IList;
      if (names == null || names.Count > 4096) throw new InvalidOperationException("Checkpoint file inventory exceeds its bound");
      var parent = Get(r, "parent"); var entries = new List<object>();
      foreach (var name in names) {
        if (!(name is string)) throw new InvalidOperationException("Checkpoint child name is invalid");
        entries.Add(StatFile(parent, (string)name));
      }
      return entries;
    }
    if (op == "truncateFile") { TruncateFile(Get(r, "parent"), Text(r, "name"), Text(r, "identity"), Number(r, "bytes")); return true; }
    if (op == "tryLock") return TryLock(Get(r, "parent"), Text(r, "name"));
    if (op == "waitLock") return WaitLock(Get(r, "parent"), Text(r, "name"), Number(r, "waitMs"), r.ContainsKey("shared") && Flag(r, "shared"));
    if (op == "openDirectory") return Register(OpenRelative(Get(r, "parent"), Text(r, "name"), true, Flag(r, "create"), false));
    if (op == "identity") return Identity(Get(r, "handle"));
    if (op == "writeFile") { WriteFile(Get(r, "parent"), Text(r, "name"), RequestBytes(r)); return true; }
    if (op == "readFile") return Convert.ToBase64String(ReadFile(Get(r, "parent"), Text(r, "name"), Number(r, "declaredBytes"), Number(r, "offset"), Number(r, "limit"), r.ContainsKey("identity") ? Text(r, "identity") : null, r.ContainsKey("prefix") && Flag(r, "prefix")));
    if (op == "listEntries") return ListEntries(Get(r, "parent"), Number(r, "maximumEntries"));
    if (op == "listEntryPage") {
      var offset = Number(r, "offset"); var limit = Number(r, "limit");
      if (offset < 0 || offset > 4096 || limit < 1 || limit > 32) throw new InvalidOperationException("Invalid directory page");
      return ReadEntries(Get(r, "parent"), offset, limit, false);
    }
    if (op == "writeRange") return WriteRange(Get(r, "parent"), Text(r, "name"), Number(r, "maximumBytes"), Number(r, "offset"), RequestBytes(r), r.ContainsKey("identity") ? Text(r, "identity") : null);
    if (op == "renameEntry") { Rename(Get(r, "sourceParent"), Text(r, "sourceName"), Get(r, "targetParent"), Text(r, "targetName"), r.ContainsKey("replace") && Flag(r, "replace")); return true; }
    if (op == "unlinkEntry") { Unlink(Get(r, "parent"), Text(r, "name"), Flag(r, "directory"), r.ContainsKey("retiredIdentity") ? Text(r, "retiredIdentity") : null, r.ContainsKey("expectedIdentity") ? Text(r, "expectedIdentity") : null); return true; }
    if (op == "sync") { if (!FlushFileBuffers(Get(r, "handle"))) throw Win32("Unable to flush checkpoint handle"); return true; }
    if (op == "close") { var id = Number(r, "handle"); var h = GetById(id); Handles.Remove(id); if (!CloseHandle(h)) throw Win32("Unable to close checkpoint handle"); return true; }
    throw new InvalidOperationException("Unsupported checkpoint bridge operation");
  }

  // Finite OS observation only; the caller owns all product/writer classification.
  static string ReadLocalProcessDeclaration(string endpoint, long expectedPid) {
    const string prefix = "\\\\.\\pipe\\";
    if (!endpoint.StartsWith(prefix, StringComparison.Ordinal) || endpoint.Length > 160 || expectedPid <= 0)
      throw new InvalidOperationException("Invalid local declaration endpoint");
    using (var pipe = new NamedPipeClientStream(".", endpoint.Substring(prefix.Length), PipeDirection.In, PipeOptions.Asynchronous)) {
      pipe.Connect(150);
      uint pid;
      if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || pid != expectedPid)
        throw new InvalidOperationException("Local declaration peer mismatch");
      var bytes = new byte[512]; var size = 0;
      var deadline = DateTime.UtcNow.AddMilliseconds(250);
      while (size < bytes.Length) {
        var read = pipe.ReadAsync(bytes, size, bytes.Length - size);
        var remaining = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
        if (!read.Wait(remaining)) throw new TimeoutException("Local declaration timed out");
        var count = read.Result;
        if (count == 0) break;
        size += count;
        if (Array.IndexOf(bytes, (byte)10, 0, size) >= 0) return Encoding.UTF8.GetString(bytes, 0, size);
      }
      throw new InvalidOperationException("Local declaration incomplete");
    }
  }

  static object ObserveNodeProcesses() {
    var entries = new List<object>(); var complete = true; var characters = 0; object failure = null;
    // WMI can take an entire close budget even for a small process inventory.
    // Enumerate the OS snapshot directly and bind identity, image and arguments
    // to one process handle; a snapshot PID alone is never an identity proof.
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw Win32("Unable to enumerate processes");
    try {
      var row = new PROCESSENTRY32 { Size = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
      var present = Process32FirstW(snapshot, ref row); var scanned = 0; var candidates = 0;
      while (present) {
        if (++scanned > 65536) { complete = false; failure = new { reason = "inventory-limit" }; break; }
        if (IsNodeImage(row.Executable)) {
          var pid = row.ProcessId;
          if (++candidates > 256) { complete = false; failure = new { reason = "inventory-limit" }; break; }
          var process = OpenProcess(0x1000 | SYNCHRONIZE, false, pid);
          if (process == IntPtr.Zero) {
            // ERROR_INVALID_PARAMETER means this snapshot PID no longer exists.
            if (Marshal.GetLastWin32Error() != 87) { complete = false; if (failure == null) failure = new { reason = "identity-unavailable", pid }; }
          } else try {
            if (WaitForSingleObject(process, 0) != 0) {
              long created, exited, kernel, user; uint size = 32768; var image = new StringBuilder((int)size);
              if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || !QueryFullProcessImageNameW(process, 0, image, ref size)) {
                if (WaitForSingleObject(process, 0) != 0) { complete = false; if (failure == null) failure = new { reason = "identity-unavailable", pid }; }
              } else if (IsNodeImage(Path.GetFileName(image.ToString()))) {
                // Keep the previous WMI microsecond precision and UTC tick format
                // so persisted writer identities remain comparable across upgrade.
                var birth = DateTime.FromFileTimeUtc(created - created % 10).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var command = ReadProcessCommandLine(process); List<string> argv = null;
                if (command != null && command.Length > 0 && command.Length <= 32768 && characters + command.Length <= 65536) {
                  characters += command.Length;
                  int count; var memory = CommandLineToArgvW(command, out count);
                  try {
                    if (memory != IntPtr.Zero && count > 0 && count <= 1024) {
                      argv = new List<string>();
                      for (var i = 0; i < count; i++) argv.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size)));
                    }
                  } finally { if (memory != IntPtr.Zero) LocalFree(memory); }
                }
                if (WaitForSingleObject(process, 0) != 0) {
                  if (argv == null) { complete = false; if (failure == null) failure = new { reason = "arguments-unavailable", pid }; }
                  entries.Add(new Dictionary<string, object> { {"pid", pid}, {"birth", birth}, {"argv", argv} });
                }
              }
            }
          } finally { CloseHandle(process); }
        }
        present = Process32NextW(snapshot, ref row);
      }
      if (!present && Marshal.GetLastWin32Error() != 18) throw Win32("Unable to complete process inventory");
    } finally { CloseHandle(snapshot); }
    var result = new Dictionary<string, object> { {"complete", complete}, {"entries", entries} };
    if (failure != null) result.Add("failure", failure);
    return result;
  }

  static bool IsNodeImage(string name) {
    return String.Equals(name, "node.exe", StringComparison.OrdinalIgnoreCase) || String.Equals(name, "node", StringComparison.OrdinalIgnoreCase);
  }

  static string ReadProcessCommandLine(IntPtr process) {
    const int capacity = 65536 + 16;
    var buffer = Marshal.AllocHGlobal(capacity);
    try {
      int required;
      if (NtQueryInformationProcess(process, 60, buffer, capacity, out required) < 0) return null;
      var text = (UNICODE_STRING)Marshal.PtrToStructure(buffer, typeof(UNICODE_STRING));
      var offset = text.Buffer.ToInt64() - buffer.ToInt64();
      if (text.Length == 0 || text.Length % 2 != 0 || text.MaximumLength < text.Length ||
          offset < Marshal.SizeOf(typeof(UNICODE_STRING)) || offset > capacity - text.Length) return null;
      return Marshal.PtrToStringUni(text.Buffer, text.Length / 2);
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  static IntPtr OpenPath(string input, bool create, bool readOnly) {
    var full = Path.GetFullPath(input);
    var root = Path.GetPathRoot(full);
    if (String.IsNullOrEmpty(root)) throw new InvalidOperationException("Checkpoint path is not absolute");
    var current = CreateFileW(root, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (current == new IntPtr(-1)) throw Win32("Unable to open checkpoint filesystem root");
    try {
      RejectReparse(current);
      var relative = full.Substring(root.Length);
      var parts = relative.Split(new[] {'\\', '/'}, StringSplitOptions.RemoveEmptyEntries);
      for (var index = 0; index < parts.Length; index++) {
        var part = parts[index];
        ExactName(part);
        var next = OpenRelative(current, part, true, create, false, !readOnly && index == parts.Length - 1);
        CloseHandle(current);
        current = next;
      }
      return current;
    } catch { CloseHandle(current); throw; }
  }

  static IntPtr OpenRelative(IntPtr parent, string name, bool directory, bool create, bool exclusive, bool writable = true, bool asynchronous = false, bool pin = false) {
    ExactName(name);
    var nameBuffer = Marshal.StringToHGlobalUni(name);
    var unicode = new UNICODE_STRING { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2)), Buffer = nameBuffer };
    var unicodePtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
    Marshal.StructureToPtr(unicode, unicodePtr, false);
    try {
      var attributes = new OBJECT_ATTRIBUTES { Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)), RootDirectory = parent, ObjectName = unicodePtr, Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE };
      IO_STATUS_BLOCK status;
      IntPtr handle;
      uint access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | (directory
        ? FILE_LIST_DIRECTORY | (writable ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | DELETE : 0)
        : FILE_READ_DATA | (writable ? FILE_WRITE_DATA | FILE_APPEND_DATA | DELETE : 0));
      uint disposition = create ? (exclusive ? FILE_CREATE : FILE_OPEN_IF) : FILE_OPEN;
      uint options = (asynchronous ? 0 : FILE_SYNCHRONOUS_IO_NONALERT) | FILE_OPEN_REPARSE_POINT | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
      var result = NtCreateFile(out handle, access, ref attributes, out status, IntPtr.Zero, 0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | (pin ? 0 : FILE_SHARE_DELETE), disposition, options, IntPtr.Zero, 0);
      if (result < 0 || handle == IntPtr.Zero || handle == new IntPtr(-1)) {
        var code = unchecked((uint)result);
        if (code == 0xC0000034 || code == 0xC000003A) throw new FileNotFoundException("checkpoint-child-missing");
        throw new InvalidOperationException("Unable to open checkpoint child relative to its frozen parent (NTSTATUS 0x" + code.ToString("x8") + ")");
      }
      try { RejectReparse(handle); return handle; } catch { CloseHandle(handle); throw; }
    } finally { Marshal.FreeHGlobal(unicodePtr); Marshal.FreeHGlobal(nameBuffer); }
  }

  static void WriteFile(IntPtr parent, string name, byte[] bytes) {
    var file = OpenRelative(parent, name, false, true, true);
    try {
      using (var safe = new SafeFileHandle(file, false))
      using (var stream = new FileStream(safe, FileAccess.Write, 64 * 1024, false)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
      BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) != bytes.LongLength) throw new InvalidOperationException("Checkpoint file identity changed during write");
    } finally { Array.Clear(bytes, 0, bytes.Length); CloseHandle(file); }
  }

  static byte[] ReadFile(IntPtr parent, string name, long declared, long offset, long limit, string expected, bool prefix) {
    if (offset < 0 || limit <= 0) throw new InvalidOperationException("Checkpoint file range is invalid");
    var file = OpenRelative(parent, name, false, false, false, false);
    try {
      BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1) throw new InvalidOperationException("Checkpoint file identity changed");
      if (expected != null && Identity(info) != expected) throw new InvalidOperationException("Checkpoint read identity changed");
      if (prefix && (expected == null || declared < 0 || offset + limit > declared)) throw new InvalidOperationException("Invalid durable prefix read");
      var actual = Size(info); if ((declared >= 0 && (prefix ? actual < declared : actual != declared)) || (declared < 0 && actual > limit) || offset > actual) throw new InvalidOperationException("Checkpoint file length changed");
      var length = checked((int)Math.Min(limit, actual - offset)); var bytes = new byte[length];
      using (var safe = new SafeFileHandle(file, false))
      using (var stream = new FileStream(safe, FileAccess.Read, 64 * 1024, false)) {
        stream.Position = offset; var read = 0; while (read < length) { var current = stream.Read(bytes, read, length - read); if (current == 0) throw new EndOfStreamException("Checkpoint file range is truncated"); read += current; }
      }
      BY_HANDLE_FILE_INFORMATION after;
      if (!GetFileInformationByHandle(file, out after) || after.NumberOfLinks != 1 || (prefix ? Size(after) < declared : Size(after) != actual) || Identity(after) != Identity(info)) throw new InvalidOperationException("Checkpoint file identity changed during read");
      return bytes;
    } finally { CloseHandle(file); }
  }

  static object StatFile(IntPtr parent, string name) {
    var file = OpenRelative(parent, name, false, false, false, false);
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1) throw new InvalidOperationException("Unsafe file identity");
      return new Dictionary<string, object> { {"bytes", Size(info)}, {"identity", Identity(info)} };
    } finally { CloseHandle(file); }
  }

  static void TruncateFile(IntPtr parent, string name, string identity, long bytes) {
    if (bytes < 0) throw new InvalidOperationException("Invalid truncate size");
    var file = OpenRelative(parent, name, false, false, false);
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Identity(info) != identity || bytes > Size(info)) throw new InvalidOperationException("Retired file identity changed");
      using (var safe = new SafeFileHandle(file, false))
      using (var stream = new FileStream(safe, FileAccess.ReadWrite, 4096, false)) { stream.SetLength(bytes); stream.Flush(true); }
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Identity(info) != identity || Size(info) != bytes) throw new InvalidOperationException("Retired file reclaim unconfirmed");
    } finally { CloseHandle(file); }
  }

  static long TryLock(IntPtr parent, string name) {
    var file = OpenRelative(parent, name, false, true, false);
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) != 0) throw new InvalidOperationException("Unsafe control lock");
      var overlapped = new OVERLAPPED();
      if (!LockFileEx(file, 3, 0, 1, 0, ref overlapped)) {
        var error = Marshal.GetLastWin32Error();
        if (error == 33) { CloseHandle(file); return 0; }
        throw new System.ComponentModel.Win32Exception(error, "Unable to acquire control lock");
      }
      return Register(file);
    } catch { CloseHandle(file); throw; }
  }

  // The kernel retains this pending request between writers' batches. No poll
  // interval, waiter files, or unbounded wait in the business process.
  static long WaitLock(IntPtr parent, string name, long waitMs, bool shared) {
    if (waitMs < 1 || waitMs > 2000) throw new InvalidOperationException("Invalid control lock wait bound");
    var file = OpenRelative(parent, name, false, !shared, false, !shared, true);
    IntPtr completion = IntPtr.Zero, overlapped = IntPtr.Zero;
    bool pending = false, retained = false;
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) != 0) throw new InvalidOperationException("Unsafe control lock");
      completion = CreateEventW(IntPtr.Zero, true, false, null);
      if (completion == IntPtr.Zero) throw Win32("Unable to create control lock event");
      overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(OVERLAPPED)));
      Marshal.StructureToPtr(new OVERLAPPED { Event = completion }, overlapped, false);
      if (!QueueLockFile(file, shared ? 0u : 2u, 0, 1, 0, overlapped)) {
        var error = Marshal.GetLastWin32Error();
        if (error != 997) throw new System.ComponentModel.Win32Exception(error, "Unable to queue control lock");
        pending = true;
        var result = WaitForSingleObject(completion, (uint)waitMs);
        if (result == 258) return 0; // finally cancels, joins, and releases even a racing grant.
        if (result != 0) throw Win32("Unable to wait for control lock");
        uint transferred;
        if (!GetOverlappedResult(file, overlapped, out transferred, true)) throw Win32("Unable to complete control lock");
        pending = false;
      }
      var id = Register(file);
      retained = true;
      return id;
    } finally {
      if (pending) {
        // OVERLAPPED memory must remain alive until cancellation really settles.
        CancelIoEx(file, overlapped);
        uint transferred;
        GetOverlappedResult(file, overlapped, out transferred, true);
      }
      if (!retained) CloseHandle(file);
      if (overlapped != IntPtr.Zero) Marshal.FreeHGlobal(overlapped);
      if (completion != IntPtr.Zero) CloseHandle(completion);
    }
  }

  static string[] ListEntries(IntPtr parent, long maximumEntries) {
    if (maximumEntries < 1 || maximumEntries > 100000) throw new InvalidOperationException("Checkpoint directory entry bound is invalid");
    return ReadEntries(parent, 0, maximumEntries, true).names;
  }

  sealed class DirectoryPage { public string[] names; public bool end; }

  static DirectoryPage ReadEntries(IntPtr parent, long skip, long maximumEntries, bool complete) {
    const int bufferSize = 64 * 1024, fileNameLengthOffset = 60, fileNameOffset = 104;
    var buffer = Marshal.AllocHGlobal(bufferSize);
    var values = new List<string>();
    var total = 0L;
    try {
      var infoClass = FileIdBothDirectoryRestartInfo;
      while (true) {
        if (!GetFileInformationByHandleEx(parent, infoClass, buffer, bufferSize)) {
          if (Marshal.GetLastWin32Error() == 18) break;
          throw Win32("Unable to enumerate checkpoint directory by handle");
        }
        var offset = 0;
        while (true) {
          var current = IntPtr.Add(buffer, offset);
          var nameBytes = Marshal.ReadInt32(current, fileNameLengthOffset);
          if (nameBytes < 0 || (nameBytes & 1) != 0 || fileNameOffset + nameBytes > bufferSize - offset) {
            throw new InvalidOperationException("Checkpoint directory entry is invalid");
          }
          var name = Marshal.PtrToStringUni(IntPtr.Add(current, fileNameOffset), nameBytes / 2);
          if (name != "." && name != "..") {
            if (!ValidName(name)) throw new InvalidOperationException("Checkpoint directory contains an unknown child name");
            if (++total > skip) {
              if (values.Count == maximumEntries) {
                if (complete) throw new InvalidOperationException("Checkpoint directory inventory exceeds its bound");
                return new DirectoryPage { names = values.ToArray(), end = false };
              }
              values.Add(name);
            }
          }
          var next = Marshal.ReadInt32(current, 0);
          if (next == 0) break;
          if (next < fileNameOffset || offset + next >= bufferSize) {
            throw new InvalidOperationException("Checkpoint directory entry offset is invalid");
          }
          offset += next;
        }
        infoClass = FileIdBothDirectoryInfo;
      }
      if (complete) values.Sort(StringComparer.Ordinal);
      return new DirectoryPage { names = values.ToArray(), end = true };
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  static long WriteRange(IntPtr parent, string name, long maximum, long offset, byte[] bytes, string expected) {
    if (maximum < 0 || offset < 0 || offset > maximum || bytes.LongLength > maximum - offset) throw new InvalidOperationException("Checkpoint file range is invalid");
    // A resumed or identity-bound prefix must already exist. Opening it may
    // fail, but must never create an unowned empty name before validation.
    var file = OpenRelative(parent, name, false, expected == null && offset == 0, false);
    try {
      BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1) throw new InvalidOperationException("Checkpoint durable prefix identity changed");
      var actual = Size(info); if (actual > maximum || offset > actual || (expected != null && (Identity(info) != expected || actual != offset))) throw new InvalidOperationException("Checkpoint durable prefix is invalid");
      using (var safe = new SafeFileHandle(file, false))
      using (var stream = new FileStream(safe, FileAccess.ReadWrite, 64 * 1024, false)) {
        stream.Position = offset;
        if (offset < actual) {
          if (offset + bytes.LongLength > actual) throw new InvalidOperationException("Checkpoint write overlaps its durable prefix");
          var replay = new byte[bytes.Length]; var read = 0;
          while (read < replay.Length) { var current = stream.Read(replay, read, replay.Length - read); if (current == 0) throw new EndOfStreamException("Checkpoint replay range is truncated"); read += current; }
          if (!System.Linq.Enumerable.SequenceEqual(replay, bytes)) throw new InvalidOperationException("Checkpoint replay changed durable bytes");
          Array.Clear(replay, 0, replay.Length);
        } else {
          stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
        }
      }
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) > maximum) throw new InvalidOperationException("Checkpoint durable prefix exceeded its bound");
      return Size(info);
    } finally { Array.Clear(bytes, 0, bytes.Length); CloseHandle(file); }
  }

  static object EntryInfo(IntPtr handle) {
    RejectReparse(handle);
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, out info)) throw Win32("Unable to inspect pinned entry");
    var directory = (info.FileAttributes & 0x10) != 0;
    if (!directory && info.NumberOfLinks != 1) throw new InvalidOperationException("Checkpoint entry has multiple links");
    // FILE_STANDARD_INFO has AllocationSize at offset 0 and EndOfFile at 8.
    var standard = Marshal.AllocHGlobal(24);
    try {
      if (!GetFileInformationByHandleEx(handle, 1, standard, 24)) throw Win32("Unable to inspect physical allocation");
      var allocated = Marshal.ReadInt64(standard, 0); var bytes = Marshal.ReadInt64(standard, 8);
      if (allocated < 0 || bytes < 0) throw new InvalidOperationException("Invalid physical allocation");
      return new { kind = directory ? "directory" : "file", bytes = bytes, allocatedBytes = allocated, identity = Identity(info) };
    } finally { Marshal.FreeHGlobal(standard); }
  }

  static long AvailableDiskBytes(IntPtr handle) {
    var path = new StringBuilder(1024);
    var length = GetFinalPathNameByHandleW(handle, path, 1024, 1); // VOLUME_NAME_GUID
    if (length == 0 || length >= 1024) throw Win32("Unable to identify pinned volume");
    var text = path.ToString(); var end = text.IndexOf("}\\", StringComparison.Ordinal);
    if (!text.StartsWith("\\\\?\\Volume{", StringComparison.OrdinalIgnoreCase) || end < 0) throw new InvalidOperationException("Pinned volume identity unavailable");
    ulong available, total, free;
    if (!GetDiskFreeSpaceExW(text.Substring(0, end + 2), out available, out total, out free) || available > (ulong)9007199254740991)
      throw Win32("Unable to query pinned volume free space");
    return (long)available;
  }

  static object StatEntry(IntPtr parent, string name) {
    IntPtr entry;
    try { entry = OpenRelative(parent, name, true, false, false, false); }
    catch { entry = OpenRelative(parent, name, false, false, false, false); }
    try { return EntryInfo(entry); } finally { CloseHandle(entry); }
  }

  static object WriteAt(IntPtr parent, string name, long maximum, long offset, byte[] bytes, string expected, bool pin) {
    if (maximum < 0 || offset < 0 || offset > maximum || bytes.LongLength > 256 * 1024 || bytes.LongLength > maximum - offset)
      throw new InvalidOperationException("Invalid bounded file write");
    ExactName(name);
    string key = parent.ToString() + ":" + name; IntPtr file = IntPtr.Zero;
    bool retained = pin && expected != null && PinnedWrites.TryGetValue(key, out file);
    if (!retained) {
      if (PinnedWrites.TryGetValue(key, out file)) { PinnedWrites.Remove(key); CloseHandle(file); }
      if (pin && PinnedWrites.Count == 4) ClosePinnedWrites();
      file = OpenRelative(parent, name, false, expected == null, expected == null, true, false, pin);
    }
    bool confirmed = false;
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) > maximum || (expected != null && Identity(info) != expected))
        throw new InvalidOperationException("Bounded file identity changed before write");
      using (var safe = new SafeFileHandle(file, false))
      // This operation already owns one finite byte buffer and performs one
      // write. A second 64 KiB FileStream buffer per index/data write adds
      // allocation/copying without combining any subsequent IO.
      using (var stream = new FileStream(safe, FileAccess.ReadWrite, 1, false)) {
        stream.Position = offset; stream.Write(bytes, 0, bytes.Length); stream.Flush();
      }
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) > maximum || (expected != null && Identity(info) != expected))
        throw new InvalidOperationException("Bounded file identity changed during write");
      var result = EntryInfo(file);
      if (pin) PinnedWrites[key] = file;
      confirmed = true; return result;
    } finally {
      Array.Clear(bytes, 0, bytes.Length);
      if (!pin || !confirmed) { PinnedWrites.Remove(key); CloseHandle(file); }
    }
  }

  static object CopyRange(IntPtr parent, string sourceName, string sourceIdentity, long sourceBytes, long sourceOffset, string targetName, string targetIdentity, long targetOffset, long length) {
    if (sourceName == targetName || sourceOffset < 0 || targetOffset < 0 || (targetIdentity == null && targetOffset != 0) || length <= 0 || length > 1024 * 1024 || sourceBytes < sourceOffset || length > sourceBytes - sourceOffset || targetOffset > 9007199254740991L - length)
      throw new InvalidOperationException("Invalid bounded file copy");
    var source = OpenRelative(parent, sourceName, false, false, false, false);
    var target = IntPtr.Zero; var bytes = new byte[64 * 1024];
    try {
      BY_HANDLE_FILE_INFORMATION sourceInfo, targetInfo;
      if (!GetFileInformationByHandle(source, out sourceInfo) || sourceInfo.NumberOfLinks != 1 || Identity(sourceInfo) != sourceIdentity || Size(sourceInfo) != sourceBytes)
        throw new InvalidOperationException("Copy source identity changed");
      target = OpenRelative(parent, targetName, false, targetIdentity == null, targetIdentity == null);
      if (!GetFileInformationByHandle(target, out targetInfo) || targetInfo.NumberOfLinks != 1 || Size(targetInfo) != targetOffset || (targetIdentity != null && Identity(targetInfo) != targetIdentity))
        throw new InvalidOperationException("Copy target identity changed");
      var targetId = Identity(targetInfo);
      if (targetId == Identity(sourceInfo)) throw new InvalidOperationException("Cannot copy a checkpoint file into itself");
      using (var sourceSafe = new SafeFileHandle(source, false))
      using (var targetSafe = new SafeFileHandle(target, false))
      using (var input = new FileStream(sourceSafe, FileAccess.Read, 64 * 1024, false))
      using (var output = new FileStream(targetSafe, FileAccess.ReadWrite, 64 * 1024, false)) {
        input.Position = sourceOffset; output.Position = targetOffset;
        for (long copied = 0; copied < length;) {
          var count = (int)Math.Min(bytes.Length, length - copied);
          var read = input.Read(bytes, 0, count); if (read == 0) throw new EndOfStreamException("Copy source range is truncated");
          output.Write(bytes, 0, read); copied += read;
        }
        output.Flush();
      }
      if (!GetFileInformationByHandle(source, out sourceInfo) || sourceInfo.NumberOfLinks != 1 || Identity(sourceInfo) != sourceIdentity || Size(sourceInfo) != sourceBytes ||
          !GetFileInformationByHandle(target, out targetInfo) || targetInfo.NumberOfLinks != 1 || Identity(targetInfo) != targetId || Size(targetInfo) != targetOffset + length)
        throw new InvalidOperationException("Copy identity changed during transfer");
      return EntryInfo(target);
    } finally { Array.Clear(bytes, 0, bytes.Length); if (target != IntPtr.Zero) CloseHandle(target); CloseHandle(source); }
  }

  static void Rename(IntPtr sourceParent, string sourceName, IntPtr targetParent, string targetName, bool replace) {
    ExactName(targetName);
    IntPtr entry;
    try { entry = OpenRelative(sourceParent, sourceName, true, false, false); }
    catch { entry = OpenRelative(sourceParent, sourceName, false, false, false); }
    var targetBytes = Encoding.Unicode.GetBytes(targetName); var size = (IntPtr.Size == 8 ? 24 : 16) + targetBytes.Length;
    var buffer = Marshal.AllocHGlobal(size); for (var i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
    try {
      BY_HANDLE_FILE_INFORMATION sourceInfo;
      if (!GetFileInformationByHandle(entry, out sourceInfo) || ((sourceInfo.FileAttributes & 0x10) == 0 && sourceInfo.NumberOfLinks != 1))
        throw new InvalidOperationException("Unsafe rename source identity");
      if (replace) {
        // Only proven absence permits a new name. Existing targets must pass
        // the ordinary reparse/link checks before the destructive rename.
        try { StatEntry(targetParent, targetName); }
        catch (FileNotFoundException) { }
      }
      Marshal.WriteInt32(buffer, 0, replace ? 1 : 0);
      Marshal.WriteIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4, targetParent);
      Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, targetBytes.Length);
      Marshal.Copy(targetBytes, 0, IntPtr.Add(buffer, IntPtr.Size == 8 ? 20 : 12), targetBytes.Length);
      IO_STATUS_BLOCK status;
      var result = NtSetInformationFile(entry, out status, buffer, (uint)size, 10);
      if (result < 0) throw new InvalidOperationException("Unable to rename checkpoint entry by handle (NTSTATUS 0x" + unchecked((uint)result).ToString("x8") + ")");
    } finally { Marshal.FreeHGlobal(buffer); CloseHandle(entry); }
  }

  static void Unlink(IntPtr parent, string name, bool directory, string retiredIdentity, string expectedIdentity) {
    var entry = OpenRelative(parent, name, directory, false, false); var size = Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)); var buffer = Marshal.AllocHGlobal(size);
    try {
      BY_HANDLE_FILE_INFORMATION identity;
      if (expectedIdentity != null && Identity(entry) != expectedIdentity) throw new InvalidOperationException("Checkpoint entry identity changed before delete");
      if (!directory && (!GetFileInformationByHandle(entry, out identity) || identity.NumberOfLinks != 1)) throw new InvalidOperationException("Checkpoint file identity changed before delete");
      if (retiredIdentity != null) {
        if (directory || !GetFileInformationByHandle(entry, out identity) || identity.NumberOfLinks != 1 || Size(identity) != 0 || Identity(identity) != retiredIdentity) throw new InvalidOperationException("Retired file space is not confirmed");
        // FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS. Truncation
        // has already been synced; namespace removal cannot hide occupied data.
        Marshal.WriteInt32(buffer, 3);
        if (!SetFileInformationByHandle(entry, 21, buffer, 4)) throw Win32("Unable to remove retired file namespace");
        return;
      }
      Marshal.StructureToPtr(new FILE_DISPOSITION_INFO { DeleteFile = true }, buffer, false);
      if (!SetFileInformationByHandle(entry, FileDispositionInfo, buffer, (uint)size)) throw new InvalidOperationException("Unable to delete checkpoint entry '" + name + "' (directory=" + directory + ") by handle (Win32 " + Marshal.GetLastWin32Error() + ")");
    }
    finally { Marshal.FreeHGlobal(buffer); CloseHandle(entry); }
  }

  static void RejectReparse(IntPtr handle) { BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(handle, out info)) throw Win32("Unable to inspect checkpoint handle"); if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException("Checkpoint path contains a reparse point"); }
  static string Identity(IntPtr handle) { BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(handle, out info)) throw Win32("Unable to inspect checkpoint handle identity"); return info.VolumeSerialNumber.ToString("x") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8"); }
  static string Identity(BY_HANDLE_FILE_INFORMATION info) { return info.VolumeSerialNumber.ToString("x") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8"); }
  static long Size(BY_HANDLE_FILE_INFORMATION info) { return ((long)info.FileSizeHigh << 32) | info.FileSizeLow; }
  static long Register(IntPtr handle) { var id = NextHandle++; Handles.Add(id, handle); return id; }
  static IntPtr Get(Dictionary<string, object> r, string name) { return GetById(Number(r, name)); }
  static IntPtr GetById(long id) { IntPtr handle; if (!Handles.TryGetValue(id, out handle)) throw new InvalidOperationException("Checkpoint handle is unknown or closed"); return handle; }
  static long Number(Dictionary<string, object> r, string name) { return Convert.ToInt64(r[name]); }
  static string Text(Dictionary<string, object> r, string name) { return Convert.ToString(r[name]); }
  static bool Flag(Dictionary<string, object> r, string name) { return Convert.ToBoolean(r[name]); }
  static void ExactName(string name) { if (String.IsNullOrEmpty(name) || name.Length > 160 || name == "." || name == ".." || name.IndexOfAny(new[] {'/', '\\', '\0'}) >= 0) throw new InvalidOperationException("Checkpoint child name is invalid"); }
  static bool ValidName(string name) { return !String.IsNullOrEmpty(name) && name.Length <= 160 && name != "." && name != ".." && name.IndexOfAny(new[] {'/', '\\', '\0'}) < 0; }
  static Exception Win32(string message) { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), message); }
  static void Reply(Dictionary<string, object> request, bool ok, object value, string error) {
    var id = request != null && request.ContainsKey("id") ? request["id"] : 0;
    if (ok && request != null && Text(request, "op") == "readFile") {
      // Dispatch alone creates this value using Convert.ToBase64String.
      // Base64 has no JSON quote/control characters; never use this for paths,
      // errors, caller-provided strings or other operation results.
      Console.WriteLine("{\"id\":" + Json.Serialize(id) + ",\"ok\":true,\"value\":\"" + (string)value + "\"}");
    } else {
      var response = new Dictionary<string, object> { {"id", id}, {"ok", ok} };
      if (ok) response["value"] = value; else response["error"] = error;
      Console.WriteLine(Json.Serialize(response));
    }
    Console.Out.Flush();
  }
}
