using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

internal sealed record Manifest(
    [property: JsonPropertyName("runtimeId")] string RuntimeId,
    [property: JsonPropertyName("archive")] string Archive,
    [property: JsonPropertyName("sha256")] string Sha256);

internal sealed class ManifestValidationException : Exception
{
}

internal sealed class PackageValidationException : Exception
{
}

internal static class ManifestValidator
{
    public static void Validate(Manifest manifest)
    {
        if (!IsRuntimeId(manifest.RuntimeId) ||
            !IsSafeRelativeWindowsPath(manifest.Archive) ||
            !IsSha256(manifest.Sha256))
        {
            throw new ManifestValidationException();
        }
    }

    public static void ValidatePackage(string baseDirectory, Manifest manifest)
    {
        Validate(manifest);

        try
        {
            using Stream stream = OperatingSystem.IsWindows()
                ? WindowsRootedFile.Open(baseDirectory, manifest.Archive)
                : OpenForNonWindowsSelfTest(baseDirectory, manifest.Archive);
            byte[] actual = HashStream(stream);
            byte[] expected = Convert.FromHexString(manifest.Sha256);
            if (!CryptographicOperations.FixedTimeEquals(expected, actual))
            {
                throw new PackageValidationException();
            }
        }
        catch (PackageValidationException)
        {
            throw;
        }
        catch
        {
            throw new PackageValidationException();
        }
    }

    private static bool IsRuntimeId(string? value)
    {
        if (string.IsNullOrEmpty(value) || !IsAsciiLetterOrDigit(value[0]))
        {
            return false;
        }

        return value.AsSpan(1).IndexOfAnyExcept("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-") < 0;
    }

    private static bool IsSafeRelativeWindowsPath(string? path)
    {
        if (string.IsNullOrEmpty(path) || path[0] is '/' or '\\')
        {
            return false;
        }

        foreach (string segment in path.Replace('\\', '/').Split('/'))
        {
            if (segment.Length == 0 || segment[^1] is ' ' or '.' ||
                segment.AsSpan().IndexOfAnyExcept("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._ -") >= 0 ||
                IsWindowsDeviceName(segment))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsWindowsDeviceName(string segment)
    {
        string baseName = segment.Split('.', 2)[0].TrimEnd(' ').ToUpperInvariant();
        if (baseName is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$")
        {
            return true;
        }

        if (baseName.Length == 4 && (baseName.StartsWith("COM", StringComparison.Ordinal) ||
            baseName.StartsWith("LPT", StringComparison.Ordinal)))
        {
            return baseName[3] is >= '1' and <= '9' or '¹' or '²' or '³';
        }

        return false;
    }

    private static bool IsSha256(string? value)
    {
        return value is { Length: 64 } &&
            value.AsSpan().IndexOfAnyExcept("0123456789abcdefABCDEF") < 0;
    }

    private static bool IsAsciiLetterOrDigit(char value) =>
        value is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9';

    private static byte[] HashStream(Stream stream)
    {
        using IncrementalHash hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[81920];
        int count;
        while ((count = stream.Read(buffer, 0, buffer.Length)) != 0)
        {
            hasher.AppendData(buffer, 0, count);
        }

        return hasher.GetHashAndReset();
    }

    private static Stream OpenForNonWindowsSelfTest(string baseDirectory, string archive)
    {
        string current = Path.GetFullPath(baseDirectory);
        foreach (string segment in archive.Replace('\\', '/').Split('/'))
        {
            current = Path.Combine(current, segment);
            FileAttributes attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new PackageValidationException();
            }
        }

        if ((File.GetAttributes(current) & FileAttributes.Directory) != 0)
        {
            throw new PackageValidationException();
        }

        return new FileStream(current, FileMode.Open, FileAccess.Read, FileShare.Read);
    }
}

internal static partial class WindowsRootedFile
{
    private const uint FileListDirectory = 0x00000001;
    private const uint FileReadAttributes = 0x00000080;
    private const uint Synchronize = 0x00100000;
    private const uint GenericRead = 0x80000000;
    private const uint ShareAll = 0x00000007;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint ObjCaseInsensitive = 0x00000040;
    private const uint ObjDontReparse = 0x00001000;
    private const uint FileOpen = 1;
    private const uint FileSynchronousIoNonalert = 0x00000020;
    private const uint FileNonDirectoryFile = 0x00000040;
    private const int FileAttributeTagInfoClass = 9;

    public static unsafe Stream Open(string baseDirectory, string archive)
    {
        using SafeFileHandle root = CreateFile(
            baseDirectory,
            FileListDirectory | FileReadAttributes | Synchronize,
            ShareAll,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero);
        if (root.IsInvalid || !TryGetAttributes(root, out FileAttributeTagInfo rootInfo) ||
            (rootInfo.FileAttributes & (FileAttributeDirectory | FileAttributeReparsePoint)) != FileAttributeDirectory)
        {
            throw new PackageValidationException();
        }

        string relativePath = archive.Replace('/', '\\');
        if (relativePath.Length > ushort.MaxValue / sizeof(char))
        {
            throw new PackageValidationException();
        }

        fixed (char* pathBuffer = relativePath)
        {
            var name = new UnicodeString
            {
                Length = checked((ushort)(relativePath.Length * sizeof(char))),
                MaximumLength = checked((ushort)(relativePath.Length * sizeof(char))),
                Buffer = (IntPtr)pathBuffer,
            };
            var attributes = new ObjectAttributes
            {
                Length = sizeof(ObjectAttributes),
                RootDirectory = root.DangerousGetHandle(),
                ObjectName = (IntPtr)(&name),
                Attributes = ObjCaseInsensitive | ObjDontReparse,
            };

            int status = NtCreateFile(
                out IntPtr rawHandle,
                GenericRead | Synchronize,
                ref attributes,
                out _,
                IntPtr.Zero,
                0,
                ShareAll,
                FileOpen,
                FileSynchronousIoNonalert | FileNonDirectoryFile | FileFlagOpenReparsePoint,
                IntPtr.Zero,
                0);
            GC.KeepAlive(root);
            if (status < 0 || rawHandle == IntPtr.Zero || rawHandle == new IntPtr(-1))
            {
                throw new PackageValidationException();
            }

            var file = new SafeFileHandle(rawHandle, ownsHandle: true);
            if (!TryGetAttributes(file, out FileAttributeTagInfo fileInfo) ||
                (fileInfo.FileAttributes & (FileAttributeDirectory | FileAttributeReparsePoint)) != 0)
            {
                file.Dispose();
                throw new PackageValidationException();
            }

            return new FileStream(file, FileAccess.Read);
        }
    }

    private static unsafe bool TryGetAttributes(SafeFileHandle handle, out FileAttributeTagInfo attributes) =>
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfoClass,
            out attributes,
            (uint)sizeof(FileAttributeTagInfo)) != 0;

    [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial int GetFileInformationByHandleEx(
        SafeFileHandle file,
        int fileInformationClass,
        out FileAttributeTagInfo fileInformation,
        uint bufferSize);

    [LibraryImport("ntdll.dll")]
    private static partial int NtCreateFile(
        out IntPtr fileHandle,
        uint desiredAccess,
        ref ObjectAttributes objectAttributes,
        out IoStatusBlock ioStatusBlock,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr eaBuffer,
        uint eaLength);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }
}
