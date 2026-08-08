#include <node_api.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#else
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif
#include <unistd.h>
#endif

namespace {

void Check(napi_env env, napi_status status, const char* message) {
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, message);
    throw std::runtime_error(message);
  }
}

std::string Utf8(napi_env env, napi_value value) {
  size_t size = 0;
  Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &size), "Expected a string");
  std::string result(size, '\0');
  Check(env, napi_get_value_string_utf8(env, value, result.data(), size + 1, &size), "Expected a string");
  return result;
}

bool Bool(napi_env env, napi_value value) {
  bool result = false;
  Check(env, napi_get_value_bool(env, value, &result), "Expected a boolean");
  return result;
}

uint64_t U64(napi_env env, napi_value value) {
  bool lossless = false;
  uint64_t result = 0;
  Check(env, napi_get_value_bigint_uint64(env, value, &result, &lossless), "Expected a handle bigint");
  if (!lossless) throw std::runtime_error("Handle bigint is not lossless");
  return result;
}

napi_value BigInt(napi_env env, uint64_t value) {
  napi_value result;
  Check(env, napi_create_bigint_uint64(env, value, &result), "Unable to create handle bigint");
  return result;
}

napi_value Integer(napi_env env, int64_t value) {
  napi_value result;
  Check(env, napi_create_int64(env, value, &result), "Unable to create integer");
  return result;
}

void ExactName(const std::string& name) {
  if (name.empty() || name.size() > 160 || name == "." || name == ".." ||
      name.find('/') != std::string::npos || name.find('\\') != std::string::npos ||
      name.find('\0') != std::string::npos) {
    throw std::runtime_error("Checkpoint child name is invalid");
  }
}

napi_value Object(napi_env env) {
  napi_value result;
  Check(env, napi_create_object(env, &result), "Unable to create object");
  return result;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  Check(env, napi_set_named_property(env, object, name, value), "Unable to set object property");
}

napi_value String(napi_env env, const std::string& value) {
  napi_value result;
  Check(env, napi_create_string_utf8(env, value.c_str(), value.size(), &result), "Unable to create string");
  return result;
}

#ifdef _WIN32

using NativeHandle = HANDLE;

std::wstring Wide(const std::string& value) {
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) throw std::runtime_error("Checkpoint path is not valid UTF-8");
  std::wstring result(length, L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length) != length) {
    throw std::runtime_error("Checkpoint path conversion failed");
  }
  return result;
}

using NtCreateFileType = NTSTATUS(NTAPI*)(
  PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
  ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);

NtCreateFileType NtCreateFileApi() {
  static auto fn = reinterpret_cast<NtCreateFileType>(
    GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  if (!fn) throw std::runtime_error("NtCreateFile is unavailable");
  return fn;
}

void AssertNotReparse(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) {
    throw std::runtime_error("Unable to inspect checkpoint handle attributes");
  }
  if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    throw std::runtime_error("Checkpoint path contains a reparse point");
  }
}

HANDLE OpenRelative(HANDLE parent, const std::wstring& name, bool directory, bool create, bool exclusive = false) {
  UNICODE_STRING unicode{};
  unicode.Buffer = const_cast<PWSTR>(name.c_str());
  unicode.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &unicode, OBJ_CASE_INSENSITIVE | 0x1000, parent, nullptr);
  IO_STATUS_BLOCK status{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const ACCESS_MASK access = SYNCHRONIZE | FILE_READ_ATTRIBUTES |
    (directory ? FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | DELETE
               : FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA | DELETE);
  const ULONG disposition = create ? (exclusive ? FILE_CREATE : FILE_OPEN_IF) : FILE_OPEN;
  const ULONG options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
    (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
  const NTSTATUS result = NtCreateFileApi()(
    &handle, access, &attributes, &status, nullptr,
    FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    disposition, options, nullptr, 0);
  if (result < 0 || handle == INVALID_HANDLE_VALUE) {
    if (result == static_cast<NTSTATUS>(0xC0000034L) || result == static_cast<NTSTATUS>(0xC000003AL)) {
      throw std::runtime_error("checkpoint-child-missing");
    }
    throw std::runtime_error("Unable to open checkpoint child relative to its frozen parent");
  }
  try {
    AssertNotReparse(handle);
  } catch (...) {
    CloseHandle(handle);
    throw;
  }
  return handle;
}

std::vector<std::wstring> Components(const std::wstring& path, const std::wstring& root) {
  std::vector<std::wstring> result;
  size_t start = root.size();
  while (start < path.size()) {
    while (start < path.size() && (path[start] == L'\\' || path[start] == L'/')) ++start;
    if (start == path.size()) break;
    size_t end = path.find_first_of(L"\\/", start);
    if (end == std::wstring::npos) end = path.size();
    const auto part = path.substr(start, end - start);
    if (part == L"." || part == L".." || part.empty()) throw std::runtime_error("Checkpoint path is invalid");
    result.push_back(part);
    start = end;
  }
  return result;
}

HANDLE OpenPath(const std::string& pathUtf8, bool create) {
  const auto input = Wide(pathUtf8);
  std::vector<wchar_t> fullBuffer(32768);
  DWORD fullLength = GetFullPathNameW(input.c_str(), static_cast<DWORD>(fullBuffer.size()), fullBuffer.data(), nullptr);
  if (fullLength == 0 || fullLength >= fullBuffer.size()) throw std::runtime_error("Checkpoint path is invalid");
  std::wstring full(fullBuffer.data(), fullLength);
  std::vector<wchar_t> rootBuffer(32768);
  if (!GetVolumePathNameW(full.c_str(), rootBuffer.data(), static_cast<DWORD>(rootBuffer.size()))) {
    throw std::runtime_error("Checkpoint filesystem root is unavailable");
  }
  std::wstring root(rootBuffer.data());
  HANDLE current = CreateFileW(
    root.c_str(), FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_ADD_SUBDIRECTORY | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (current == INVALID_HANDLE_VALUE) throw std::runtime_error("Unable to open checkpoint filesystem root");
  try {
    AssertNotReparse(current);
    for (const auto& part : Components(full, root)) {
      HANDLE next = OpenRelative(current, part, true, create);
      CloseHandle(current);
      current = next;
    }
    return current;
  } catch (...) {
    CloseHandle(current);
    throw;
  }
}

std::string IdentityValue(HANDLE handle) {
  FILE_ID_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info))) {
    throw std::runtime_error("Unable to inspect checkpoint handle identity");
  }
  static const char* hex = "0123456789abcdef";
  std::string result = std::to_string(info.VolumeSerialNumber) + ":";
  for (unsigned char byte : info.FileId.Identifier) {
    result.push_back(hex[byte >> 4]);
    result.push_back(hex[byte & 15]);
  }
  return result;
}

void Flush(HANDLE handle) {
  if (!FlushFileBuffers(handle) && GetLastError() != ERROR_INVALID_FUNCTION) {
    throw std::runtime_error("Unable to flush checkpoint handle");
  }
}

#else

using NativeHandle = int;

NativeHandle OpenPath(const std::string& path, bool create) {
  if (path.empty() || path[0] != '/') throw std::runtime_error("Checkpoint path must be absolute");
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) throw std::runtime_error("Unable to open checkpoint filesystem root");
  size_t start = 1;
  try {
    while (start < path.size()) {
      while (start < path.size() && path[start] == '/') ++start;
      if (start == path.size()) break;
      size_t end = path.find('/', start);
      if (end == std::string::npos) end = path.size();
      const auto part = path.substr(start, end - start);
      ExactName(part);
      if (create && mkdirat(current, part.c_str(), 0700) < 0 && errno != EEXIST) {
        throw std::runtime_error("Unable to create checkpoint directory");
      }
      int next = openat(current, part.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (next < 0) throw std::runtime_error("Unable to open checkpoint directory without following links");
      close(current);
      current = next;
      start = end;
    }
    return current;
  } catch (...) {
    close(current);
    throw;
  }
}

NativeHandle OpenRelative(NativeHandle parent, const std::string& name, bool directory, bool create, bool exclusive = false) {
  ExactName(name);
  if (directory && create && mkdirat(parent, name.c_str(), 0700) < 0 && errno != EEXIST) {
    throw std::runtime_error("Unable to create checkpoint directory");
  }
  int flags = O_CLOEXEC | O_NOFOLLOW | (directory ? O_RDONLY | O_DIRECTORY : O_RDWR);
  if (!directory && create) flags |= O_CREAT | (exclusive ? O_EXCL : 0);
  int result = openat(parent, name.c_str(), flags, 0600);
  if (result < 0) {
    if (errno == ENOENT) throw std::runtime_error("checkpoint-child-missing");
    throw std::runtime_error("Unable to open checkpoint child relative to its frozen parent");
  }
  return result;
}

std::string IdentityValue(NativeHandle handle) {
  struct stat info{};
  if (fstat(handle, &info) < 0) throw std::runtime_error("Unable to inspect checkpoint handle identity");
  return std::to_string(static_cast<uint64_t>(info.st_dev)) + ":" +
    std::to_string(static_cast<uint64_t>(info.st_ino));
}

void Flush(NativeHandle handle) {
  if (fsync(handle) < 0) throw std::runtime_error("Unable to flush checkpoint handle");
}

void RenameNoReplace(
  NativeHandle sourceParent,
  const std::string& source,
  NativeHandle targetParent,
  const std::string& target
) {
#if defined(__linux__)
  constexpr unsigned int kRenameNoReplace = 1;
  if (syscall(SYS_renameat2, sourceParent, source.c_str(), targetParent, target.c_str(), kRenameNoReplace) < 0) {
    throw std::runtime_error("Unable to rename checkpoint entry by handle without replacement");
  }
#elif defined(__APPLE__)
  if (renameatx_np(sourceParent, source.c_str(), targetParent, target.c_str(), RENAME_EXCL) < 0) {
    throw std::runtime_error("Unable to rename checkpoint entry by handle without replacement");
  }
#else
#error "Checkpoint child bridge requires an atomic no-replace relative rename primitive"
#endif
}

#endif

NativeHandle Handle(uint64_t value) {
#ifdef _WIN32
  return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(value));
#else
  return static_cast<int>(value);
#endif
}

uint64_t HandleValue(NativeHandle handle) {
#ifdef _WIN32
  return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(handle));
#else
  return static_cast<uint64_t>(handle);
#endif
}

napi_value OpenPathCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2; napi_value args[2]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    return BigInt(env, HandleValue(OpenPath(Utf8(env, args[0]), Bool(env, args[1]))));
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value OpenDirectoryCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    const auto name = Utf8(env, args[1]); ExactName(name);
#ifdef _WIN32
    auto child = OpenRelative(Handle(U64(env, args[0])), Wide(name), true, Bool(env, args[2]));
#else
    auto child = OpenRelative(Handle(U64(env, args[0])), name, true, Bool(env, args[2]));
#endif
    return BigInt(env, HandleValue(child));
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value IdentityCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    return String(env, IdentityValue(Handle(U64(env, args[0]))));
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value WriteFileCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    const auto name = Utf8(env, args[1]); ExactName(name);
    void* data = nullptr; size_t length = 0;
    Check(env, napi_get_buffer_info(env, args[2], &data, &length), "Expected a byte buffer");
#ifdef _WIN32
    HANDLE file = OpenRelative(Handle(U64(env, args[0])), Wide(name), false, true, true);
    try {
      size_t offset = 0;
      while (offset < length) { DWORD written = 0; if (!WriteFile(file, static_cast<char*>(data) + offset, static_cast<DWORD>(std::min<size_t>(length - offset, 1u << 30)), &written, nullptr) || written == 0) throw std::runtime_error("Checkpoint file write made no progress"); offset += written; }
      Flush(file);
      BY_HANDLE_FILE_INFORMATION info{}; if (!GetFileInformationByHandle(file, &info) || info.nNumberOfLinks != 1 || (static_cast<uint64_t>(info.nFileSizeHigh) << 32 | info.nFileSizeLow) != length) throw std::runtime_error("Checkpoint file identity changed during write");
      CloseHandle(file);
    } catch (...) { CloseHandle(file); throw; }
#else
    int file = OpenRelative(Handle(U64(env, args[0])), name, false, true, true);
    try {
      size_t offset = 0;
      while (offset < length) { ssize_t written = write(file, static_cast<char*>(data) + offset, length - offset); if (written <= 0) throw std::runtime_error("Checkpoint file write made no progress"); offset += static_cast<size_t>(written); }
      Flush(file);
      struct stat st{}; if (fstat(file, &st) < 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || static_cast<uint64_t>(st.st_size) != length) throw std::runtime_error("Checkpoint file identity changed during write");
      close(file);
    } catch (...) { close(file); throw; }
#endif
    return nullptr;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value ReadFileCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 5; napi_value args[5]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    const auto name = Utf8(env, args[1]); ExactName(name);
    int64_t declared = 0, offset = 0, limit = 0;
    Check(env, napi_get_value_int64(env, args[2], &declared), "Invalid declared length");
    Check(env, napi_get_value_int64(env, args[3], &offset), "Invalid offset");
    Check(env, napi_get_value_int64(env, args[4], &limit), "Invalid limit");
    if (offset < 0 || limit <= 0) throw std::runtime_error("Checkpoint file range is invalid");
    napi_value buffer;
#ifdef _WIN32
    HANDLE file = OpenRelative(Handle(U64(env, args[0])), Wide(name), false, false);
    try {
      LARGE_INTEGER size{}; if (!GetFileSizeEx(file, &size) || (declared >= 0 && size.QuadPart != declared) || (declared < 0 && size.QuadPart > limit) || offset > size.QuadPart) throw std::runtime_error("Checkpoint file length changed");
      const size_t length = static_cast<size_t>(std::min<int64_t>(limit, size.QuadPart - offset));
      void* data = nullptr; Check(env, napi_create_buffer(env, length, &data, &buffer), "Unable to allocate checkpoint range");
      LARGE_INTEGER position{}; position.QuadPart = offset; if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN)) throw std::runtime_error("Unable to seek checkpoint file");
      size_t readTotal = 0; while (readTotal < length) { DWORD readNow = 0; if (!ReadFile(file, static_cast<char*>(data) + readTotal, static_cast<DWORD>(length - readTotal), &readNow, nullptr) || readNow == 0) throw std::runtime_error("Checkpoint file range is truncated"); readTotal += readNow; }
      CloseHandle(file);
    } catch (...) { CloseHandle(file); throw; }
#else
    int file = OpenRelative(Handle(U64(env, args[0])), name, false, false);
    try {
      struct stat st{}; if (fstat(file, &st) < 0 || (declared >= 0 && st.st_size != declared) || (declared < 0 && st.st_size > limit) || offset > st.st_size || !S_ISREG(st.st_mode) || st.st_nlink != 1) throw std::runtime_error("Checkpoint file identity changed");
      const size_t length = static_cast<size_t>(std::min<int64_t>(limit, st.st_size - offset));
      void* data = nullptr; Check(env, napi_create_buffer(env, length, &data, &buffer), "Unable to allocate checkpoint range");
      size_t readTotal = 0; while (readTotal < length) { ssize_t readNow = pread(file, static_cast<char*>(data) + readTotal, length - readTotal, offset + readTotal); if (readNow <= 0) throw std::runtime_error("Checkpoint file range is truncated"); readTotal += static_cast<size_t>(readNow); }
      close(file);
    } catch (...) { close(file); throw; }
#endif
    return buffer;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value WriteRangeCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 5; napi_value args[5]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    const auto name = Utf8(env, args[1]); ExactName(name);
    int64_t maximum = 0, offset = 0;
    Check(env, napi_get_value_int64(env, args[2], &maximum), "Invalid maximum length");
    Check(env, napi_get_value_int64(env, args[3], &offset), "Invalid offset");
    void* data = nullptr; size_t length = 0;
    Check(env, napi_get_buffer_info(env, args[4], &data, &length), "Expected a byte buffer");
    if (maximum < 0 || offset < 0 || offset > maximum || static_cast<uint64_t>(offset) + length > static_cast<uint64_t>(maximum)) {
      throw std::runtime_error("Checkpoint file range is invalid");
    }
#ifdef _WIN32
    HANDLE file = OpenRelative(Handle(U64(env, args[0])), Wide(name), false, true);
    try {
      LARGE_INTEGER size{}; if (!GetFileSizeEx(file, &size) || size.QuadPart > maximum || offset > size.QuadPart) throw std::runtime_error("Checkpoint durable prefix is invalid");
      LARGE_INTEGER position{}; position.QuadPart = offset; if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN)) throw std::runtime_error("Unable to seek checkpoint file");
      if (offset < size.QuadPart) {
        if (static_cast<uint64_t>(offset) + length > static_cast<uint64_t>(size.QuadPart)) throw std::runtime_error("Checkpoint write overlaps its durable prefix");
        std::vector<unsigned char> replay(length);
        size_t readTotal = 0; while (readTotal < length) { DWORD readNow = 0; if (!ReadFile(file, replay.data() + readTotal, static_cast<DWORD>(length - readTotal), &readNow, nullptr) || readNow == 0) throw std::runtime_error("Checkpoint replay range is truncated"); readTotal += readNow; }
        if (memcmp(replay.data(), data, length) != 0) throw std::runtime_error("Checkpoint replay changed durable bytes");
      } else {
        size_t writtenTotal = 0; while (writtenTotal < length) { DWORD writtenNow = 0; if (!WriteFile(file, static_cast<char*>(data) + writtenTotal, static_cast<DWORD>(length - writtenTotal), &writtenNow, nullptr) || writtenNow == 0) throw std::runtime_error("Checkpoint range write made no progress"); writtenTotal += writtenNow; }
        Flush(file);
      }
      if (!GetFileSizeEx(file, &size) || size.QuadPart > maximum) throw std::runtime_error("Checkpoint durable prefix exceeded its bound");
      CloseHandle(file);
      return Integer(env, size.QuadPart);
    } catch (...) { CloseHandle(file); throw; }
#else
    int file = OpenRelative(Handle(U64(env, args[0])), name, false, true);
    try {
      struct stat st{}; if (fstat(file, &st) < 0 || st.st_size > maximum || offset > st.st_size || !S_ISREG(st.st_mode) || st.st_nlink != 1) throw std::runtime_error("Checkpoint durable prefix is invalid");
      if (offset < st.st_size) {
        if (static_cast<uint64_t>(offset) + length > static_cast<uint64_t>(st.st_size)) throw std::runtime_error("Checkpoint write overlaps its durable prefix");
        std::vector<unsigned char> replay(length);
        size_t readTotal = 0; while (readTotal < length) { ssize_t readNow = pread(file, replay.data() + readTotal, length - readTotal, offset + readTotal); if (readNow <= 0) throw std::runtime_error("Checkpoint replay range is truncated"); readTotal += static_cast<size_t>(readNow); }
        if (memcmp(replay.data(), data, length) != 0) throw std::runtime_error("Checkpoint replay changed durable bytes");
      } else {
        size_t writtenTotal = 0; while (writtenTotal < length) { ssize_t writtenNow = pwrite(file, static_cast<char*>(data) + writtenTotal, length - writtenTotal, offset + writtenTotal); if (writtenNow <= 0) throw std::runtime_error("Checkpoint range write made no progress"); writtenTotal += static_cast<size_t>(writtenNow); }
        Flush(file);
      }
      if (fstat(file, &st) < 0 || st.st_size > maximum || !S_ISREG(st.st_mode) || st.st_nlink != 1) throw std::runtime_error("Checkpoint durable prefix exceeded its bound");
      close(file);
      return Integer(env, st.st_size);
    } catch (...) { close(file); throw; }
#endif
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value RenameCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 4; napi_value args[4]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    const auto source = Utf8(env, args[1]); const auto target = Utf8(env, args[3]); ExactName(source); ExactName(target);
#ifdef _WIN32
    HANDLE file;
    try { file = OpenRelative(Handle(U64(env, args[0])), Wide(source), true, false); }
    catch (...) { file = OpenRelative(Handle(U64(env, args[0])), Wide(source), false, false); }
    const auto wide = Wide(target);
    std::vector<unsigned char> storage(sizeof(FILE_RENAME_INFO) + wide.size() * sizeof(wchar_t));
    auto* renameInfo = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    renameInfo->ReplaceIfExists = FALSE; renameInfo->RootDirectory = Handle(U64(env, args[2])); renameInfo->FileNameLength = static_cast<DWORD>(wide.size() * sizeof(wchar_t));
    memcpy(renameInfo->FileName, wide.data(), renameInfo->FileNameLength);
    if (!SetFileInformationByHandle(file, FileRenameInfo, renameInfo, static_cast<DWORD>(storage.size()))) { CloseHandle(file); throw std::runtime_error("Unable to rename checkpoint entry by handle"); }
    CloseHandle(file);
#else
    RenameNoReplace(
      Handle(U64(env, args[0])), source,
      Handle(U64(env, args[2])), target);
#endif
    return nullptr;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value UnlinkCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 3; napi_value args[3]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
    const auto name = Utf8(env, args[1]); ExactName(name); const bool directory = Bool(env, args[2]);
#ifdef _WIN32
    HANDLE child = OpenRelative(Handle(U64(env, args[0])), Wide(name), directory, false);
    if (!directory) { BY_HANDLE_FILE_INFORMATION info{}; if (!GetFileInformationByHandle(child, &info) || info.nNumberOfLinks != 1) { CloseHandle(child); throw std::runtime_error("Checkpoint file identity changed before delete"); } }
    FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(child, FileDispositionInfo, &disposition, sizeof(disposition))) { CloseHandle(child); throw std::runtime_error("Unable to delete checkpoint entry by handle"); }
    CloseHandle(child);
#else
    if (!directory) {
      int child = OpenRelative(Handle(U64(env, args[0])), name, false, false);
      struct stat st{}; if (fstat(child, &st) < 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1) { close(child); throw std::runtime_error("Checkpoint file identity changed before delete"); }
      close(child);
    }
    if (unlinkat(Handle(U64(env, args[0])), name.c_str(), directory ? AT_REMOVEDIR : 0) < 0) {
      if (errno == ENOENT) throw std::runtime_error("checkpoint-child-missing");
      throw std::runtime_error("Unable to delete checkpoint entry by handle");
    }
#endif
    return nullptr;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value SyncCall(napi_env env, napi_callback_info info) {
  try { size_t argc = 1; napi_value args[1]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call"); Flush(Handle(U64(env, args[0]))); return nullptr; }
  catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value CloseCall(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1; napi_value args[1]; Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr), "Invalid call");
#ifdef _WIN32
    if (!CloseHandle(Handle(U64(env, args[0])))) throw std::runtime_error("Unable to close checkpoint handle");
#else
    if (close(Handle(U64(env, args[0]))) < 0) throw std::runtime_error("Unable to close checkpoint handle");
#endif
    return nullptr;
  } catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"openPath", nullptr, OpenPathCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openDirectory", nullptr, OpenDirectoryCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"identity", nullptr, IdentityCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"writeFile", nullptr, WriteFileCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readFile", nullptr, ReadFileCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"writeRange", nullptr, WriteRangeCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renameEntry", nullptr, RenameCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unlinkEntry", nullptr, UnlinkCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sync", nullptr, SyncCall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, CloseCall, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  Check(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties), "Unable to export bridge");
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
