using System;
using System.Collections.Generic;
using System.IO;
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
  const int FileRenameInfo = 3, FileDispositionInfo = 4;

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
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushFileBuffers(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(IntPtr handle, int cls, IntPtr info, uint size);
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out IntPtr handle, uint access, ref OBJECT_ATTRIBUTES attributes, out IO_STATUS_BLOCK status,
    IntPtr allocationSize, uint fileAttributes, uint share, uint disposition, uint options, IntPtr eaBuffer, uint eaLength);
  [DllImport("ntdll.dll")]
  static extern int NtSetInformationFile(IntPtr handle, out IO_STATUS_BLOCK status, IntPtr information, uint length, int informationClass);

  static readonly Dictionary<long, IntPtr> Handles = new Dictionary<long, IntPtr>();
  static long NextHandle = 1;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };

  static void Main() {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    string line;
    while ((line = Console.ReadLine()) != null) {
      Dictionary<string, object> request = null;
      try {
        request = Json.Deserialize<Dictionary<string, object>>(line);
        var value = Dispatch(request);
        Reply(request, true, value, null);
      } catch (Exception error) {
        Reply(request, false, null, error.Message);
      }
    }
    foreach (var handle in Handles.Values) CloseHandle(handle);
  }

  static object Dispatch(Dictionary<string, object> r) {
    var op = Text(r, "op");
    if (op == "openPath") return Register(OpenPath(Text(r, "path"), Flag(r, "create")));
    if (op == "openDirectory") return Register(OpenRelative(Get(r, "parent"), Text(r, "name"), true, Flag(r, "create"), false));
    if (op == "identity") return Identity(Get(r, "handle"));
    if (op == "writeFile") { WriteFile(Get(r, "parent"), Text(r, "name"), Convert.FromBase64String(Text(r, "data"))); return true; }
    if (op == "readFile") return Convert.ToBase64String(ReadFile(Get(r, "parent"), Text(r, "name"), Number(r, "declaredBytes"), Number(r, "offset"), Number(r, "limit")));
    if (op == "writeRange") return WriteRange(Get(r, "parent"), Text(r, "name"), Number(r, "maximumBytes"), Number(r, "offset"), Convert.FromBase64String(Text(r, "data")));
    if (op == "renameEntry") { Rename(Get(r, "sourceParent"), Text(r, "sourceName"), Get(r, "targetParent"), Text(r, "targetName")); return true; }
    if (op == "unlinkEntry") { Unlink(Get(r, "parent"), Text(r, "name"), Flag(r, "directory")); return true; }
    if (op == "sync") { if (!FlushFileBuffers(Get(r, "handle"))) throw Win32("Unable to flush checkpoint handle"); return true; }
    if (op == "close") { var id = Number(r, "handle"); var h = GetById(id); Handles.Remove(id); if (!CloseHandle(h)) throw Win32("Unable to close checkpoint handle"); return true; }
    throw new InvalidOperationException("Unsupported checkpoint bridge operation");
  }

  static IntPtr OpenPath(string input, bool create) {
    var full = Path.GetFullPath(input);
    var root = Path.GetPathRoot(full);
    if (String.IsNullOrEmpty(root)) throw new InvalidOperationException("Checkpoint path is not absolute");
    var current = CreateFileW(root, FILE_LIST_DIRECTORY | FILE_ADD_SUBDIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
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
        var next = OpenRelative(current, part, true, create, false, index == parts.Length - 1);
        CloseHandle(current);
        current = next;
      }
      return current;
    } catch { CloseHandle(current); throw; }
  }

  static IntPtr OpenRelative(IntPtr parent, string name, bool directory, bool create, bool exclusive, bool writable = true) {
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
      uint options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
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

  static byte[] ReadFile(IntPtr parent, string name, long declared, long offset, long limit) {
    if (offset < 0 || limit <= 0) throw new InvalidOperationException("Checkpoint file range is invalid");
    var file = OpenRelative(parent, name, false, false, false);
    try {
      BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1) throw new InvalidOperationException("Checkpoint file identity changed");
      var actual = Size(info); if ((declared >= 0 && actual != declared) || (declared < 0 && actual > limit) || offset > actual) throw new InvalidOperationException("Checkpoint file length changed");
      var length = checked((int)Math.Min(limit, actual - offset)); var bytes = new byte[length];
      using (var safe = new SafeFileHandle(file, false))
      using (var stream = new FileStream(safe, FileAccess.Read, 64 * 1024, false)) {
        stream.Position = offset; var read = 0; while (read < length) { var current = stream.Read(bytes, read, length - read); if (current == 0) throw new EndOfStreamException("Checkpoint file range is truncated"); read += current; }
      }
      BY_HANDLE_FILE_INFORMATION after;
      if (!GetFileInformationByHandle(file, out after) || after.NumberOfLinks != 1 || Size(after) != actual || Identity(after) != Identity(info)) throw new InvalidOperationException("Checkpoint file identity changed during read");
      return bytes;
    } finally { CloseHandle(file); }
  }

  static long WriteRange(IntPtr parent, string name, long maximum, long offset, byte[] bytes) {
    if (maximum < 0 || offset < 0 || offset > maximum || offset + bytes.LongLength > maximum) throw new InvalidOperationException("Checkpoint file range is invalid");
    var file = OpenRelative(parent, name, false, true, false);
    try {
      BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(file, out info) || info.NumberOfLinks != 1) throw new InvalidOperationException("Checkpoint durable prefix identity changed");
      var actual = Size(info); if (actual > maximum || offset > actual) throw new InvalidOperationException("Checkpoint durable prefix is invalid");
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

  static void Rename(IntPtr sourceParent, string sourceName, IntPtr targetParent, string targetName) {
    IntPtr entry;
    try { entry = OpenRelative(sourceParent, sourceName, true, false, false); }
    catch { entry = OpenRelative(sourceParent, sourceName, false, false, false); }
    var targetBytes = Encoding.Unicode.GetBytes(targetName); var size = (IntPtr.Size == 8 ? 24 : 16) + targetBytes.Length;
    var buffer = Marshal.AllocHGlobal(size); for (var i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
    try {
      Marshal.WriteInt32(buffer, 0, 0);
      Marshal.WriteIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4, targetParent);
      Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, targetBytes.Length);
      Marshal.Copy(targetBytes, 0, IntPtr.Add(buffer, IntPtr.Size == 8 ? 20 : 12), targetBytes.Length);
      IO_STATUS_BLOCK status;
      var result = NtSetInformationFile(entry, out status, buffer, (uint)size, 10);
      if (result < 0) throw new InvalidOperationException("Unable to rename checkpoint entry by handle (NTSTATUS 0x" + unchecked((uint)result).ToString("x8") + ")");
    } finally { Marshal.FreeHGlobal(buffer); CloseHandle(entry); }
  }

  static void Unlink(IntPtr parent, string name, bool directory) {
    var entry = OpenRelative(parent, name, directory, false, false); var size = Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)); var buffer = Marshal.AllocHGlobal(size);
    try {
      BY_HANDLE_FILE_INFORMATION identity;
      if (!directory && (!GetFileInformationByHandle(entry, out identity) || identity.NumberOfLinks != 1)) throw new InvalidOperationException("Checkpoint file identity changed before delete");
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
  static Exception Win32(string message) { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), message); }
  static void Reply(Dictionary<string, object> request, bool ok, object value, string error) { var response = new Dictionary<string, object> { {"id", request != null && request.ContainsKey("id") ? request["id"] : 0}, {"ok", ok} }; if (ok) response["value"] = value; else response["error"] = error; Console.WriteLine(Json.Serialize(response)); Console.Out.Flush(); }
}
