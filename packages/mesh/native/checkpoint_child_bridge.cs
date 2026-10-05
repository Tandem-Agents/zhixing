using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Management;
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
  static long NextHandle = 1;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };

  static void Main() {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    // Only the containing foreground owner supplies this fixed private pipe.
    // Ordinary checkpoint/logging owners retain their existing stdio protocol.
    var endpoint = Environment.GetEnvironmentVariable("ZHIXING_CHECKPOINT_PIPE");
    NamedPipeClientStream transport = null;
    if (endpoint != null) {
      const string prefix = "\\\\.\\pipe\\zhixing-terminal-";
      if (!endpoint.StartsWith(prefix, StringComparison.Ordinal) || endpoint.Length > 160) throw new InvalidOperationException("Invalid filesystem owner pipe");
      transport = new NamedPipeClientStream(".", endpoint.Substring(9), PipeDirection.InOut);
      transport.Connect(5000);
      Console.SetIn(new StreamReader(transport, new UTF8Encoding(false), false, 4096, true));
      Console.SetOut(new StreamWriter(transport, new UTF8Encoding(false), 4096, true) { AutoFlush = true });
    }
    string line;
    while ((line = Console.ReadLine()) != null) {
      Dictionary<string, object> request = null;
      try {
        request = Json.Deserialize<Dictionary<string, object>>(line);
        var value = Dispatch(request);
        Reply(request, true, value, null);
      } catch (Exception error) {
        var native = error as System.ComponentModel.Win32Exception;
        Reply(request, false, null, native == null ? error.Message : error.Message + " (Win32 " + native.NativeErrorCode + ")");
      }
    }
    foreach (var handle in Handles.Values) CloseHandle(handle);
    if (transport != null) transport.Dispose();
  }

  static object Dispatch(Dictionary<string, object> r) {
    var op = Text(r, "op");
    if (op == "observeNodeProcesses") return ObserveNodeProcesses();
    if (op == "readLocalProcessDeclaration") return ReadLocalProcessDeclaration(Text(r, "endpoint"), Number(r, "pid"));
    if (op == "openPath") return Register(OpenPath(Text(r, "path"), Flag(r, "create"), r.ContainsKey("readOnly") && Flag(r, "readOnly")));
    if (op == "statFile") return StatFile(Get(r, "parent"), Text(r, "name"));
    if (op == "statEntry") return StatEntry(Get(r, "parent"), Text(r, "name"));
    if (op == "availableDiskBytes") return AvailableDiskBytes(Get(r, "handle"));
    if (op == "writeAt") return WriteAt(Get(r, "parent"), Text(r, "name"), Number(r, "maximumBytes"), Number(r, "offset"), Convert.FromBase64String(Text(r, "data")), r.ContainsKey("identity") ? Text(r, "identity") : null);
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
    if (op == "writeFile") { WriteFile(Get(r, "parent"), Text(r, "name"), Convert.FromBase64String(Text(r, "data"))); return true; }
    if (op == "readFile") return Convert.ToBase64String(ReadFile(Get(r, "parent"), Text(r, "name"), Number(r, "declaredBytes"), Number(r, "offset"), Number(r, "limit"), r.ContainsKey("identity") ? Text(r, "identity") : null, r.ContainsKey("prefix") && Flag(r, "prefix")));
    if (op == "listEntries") return ListEntries(Get(r, "parent"), Number(r, "maximumEntries"));
    if (op == "listEntryPage") {
      var offset = Number(r, "offset"); var limit = Number(r, "limit");
      if (offset < 0 || offset > 4096 || limit < 1 || limit > 32) throw new InvalidOperationException("Invalid directory page");
      return ReadEntries(Get(r, "parent"), offset, limit, false);
    }
    if (op == "writeRange") return WriteRange(Get(r, "parent"), Text(r, "name"), Number(r, "maximumBytes"), Number(r, "offset"), Convert.FromBase64String(Text(r, "data")), r.ContainsKey("identity") ? Text(r, "identity") : null);
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
    using (var search = new ManagementObjectSearcher("SELECT ProcessId, CreationDate, CommandLine FROM Win32_Process WHERE Name='node.exe' OR Name='node'")) {
      search.Options.Timeout = TimeSpan.FromSeconds(2);
      // This inventory is consumed once, forward only. Avoid retaining a
      // rewindable COM enumeration and fetching each row in a separate batch.
      // Freshness, identity sources and conservative completeness stay intact.
      search.Options.Rewindable = false;
      search.Options.BlockSize = 16;
      using (var rows = search.Get()) foreach (ManagementObject row in rows) using (row) {
        if (entries.Count >= 256) { complete = false; if (failure == null) failure = new { reason = "inventory-limit" }; break; }
        var pid = Convert.ToInt32(row["ProcessId"]);
        var creation = row["CreationDate"] as string;
        if (creation == null) {
          if (ProcessHasExited(pid)) continue;
          complete = false; if (failure == null) failure = new { reason = "identity-unavailable", pid }; continue;
        }
        var birth = ManagementDateTimeConverter.ToDateTime(creation).ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var command = row["CommandLine"] as string; List<string> argv = null;
        if (command != null && command.Length <= 32768 && characters + command.Length <= 65536) {
          characters += command.Length;
          int count; var memory = CommandLineToArgvW(command, out count);
          try {
            if (memory != IntPtr.Zero && count <= 1024) {
              argv = new List<string>();
              for (var i = 0; i < count; i++) argv.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size)));
            }
          } finally { if (memory != IntPtr.Zero) LocalFree(memory); }
        }
        if (argv == null) {
          // WMI can retain a row after exit while CommandLine has already vanished.
          // Only OS-proven exit permits exclusion; unreadable live peers still block.
          if (ProcessHasExited(pid)) continue;
          complete = false; if (failure == null) failure = new { reason = "arguments-unavailable", pid };
        }
        entries.Add(new Dictionary<string, object> { {"pid", pid}, {"birth", birth}, {"argv", argv} });
      }
    }
    var result = new Dictionary<string, object> { {"complete", complete}, {"entries", entries} };
    if (failure != null) result.Add("failure", failure);
    return result;
  }

  static bool ProcessHasExited(int pid) {
    try { using (var process = System.Diagnostics.Process.GetProcessById(pid)) return process.HasExited; }
    catch (ArgumentException) { return true; }
    catch (System.ComponentModel.Win32Exception error) { return error.NativeErrorCode == 87; }
    catch (InvalidOperationException) { return true; }
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

  static IntPtr OpenRelative(IntPtr parent, string name, bool directory, bool create, bool exclusive, bool writable = true, bool asynchronous = false) {
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
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, disposition, options, IntPtr.Zero, 0);
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

  static object WriteAt(IntPtr parent, string name, long maximum, long offset, byte[] bytes, string expected) {
    if (maximum < 0 || offset < 0 || offset > maximum || bytes.LongLength > 256 * 1024 || bytes.LongLength > maximum - offset)
      throw new InvalidOperationException("Invalid bounded file write");
    var file = OpenRelative(parent, name, false, expected == null, expected == null);
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) > maximum || (expected != null && Identity(info) != expected))
        throw new InvalidOperationException("Bounded file identity changed before write");
      using (var safe = new SafeFileHandle(file, false))
      using (var stream = new FileStream(safe, FileAccess.ReadWrite, 64 * 1024, false)) {
        stream.Position = offset; stream.Write(bytes, 0, bytes.Length); stream.Flush();
      }
      if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1 || Size(info) > maximum || (expected != null && Identity(info) != expected))
        throw new InvalidOperationException("Bounded file identity changed during write");
      return EntryInfo(file);
    } finally { Array.Clear(bytes, 0, bytes.Length); CloseHandle(file); }
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
  static void Reply(Dictionary<string, object> request, bool ok, object value, string error) { var response = new Dictionary<string, object> { {"id", request != null && request.ContainsKey("id") ? request["id"] : 0}, {"ok", ok} }; if (ok) response["value"] = value; else response["error"] = error; Console.WriteLine(Json.Serialize(response)); Console.Out.Flush(); }
}
