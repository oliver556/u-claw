param(
    [Parameter(Mandatory)]
    [string]$GoExe,

    [Parameter(Mandatory)]
    [string]$DotnetExe,

    [Parameter(Mandatory)]
    [ValidateRange(5, 100)]
    [int]$Iterations,

    [Parameter(Mandatory)]
    [ValidateRange(1, 3)]
    [int]$Trial,

    [Parameter(Mandatory)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

class LauncherBenchmarkError : System.Exception {
    [string]$ErrorCode

    LauncherBenchmarkError([string]$errorCode) : base('launcher benchmark failed') {
        $this.ErrorCode = $errorCode
    }
}

$metadataParserSource = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

public sealed class LauncherBuildMetadata
{
    public int SchemaVersion { get; set; }
    public string Candidate { get; set; }
    public string CommitSha { get; set; }
    public double BuildMs { get; set; }
    public string ToolchainVersion { get; set; }
}

public static class LauncherBuildMetadataParser
{
    public static LauncherBuildMetadata Parse(string path, string expectedCandidate)
    {
        string json;
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (StreamReader reader = new StreamReader(
            stream, new UTF8Encoding(false, true), false))
        {
            json = reader.ReadToEnd();
        }

        var members = new StrictJsonReader(json).ReadObject();

        string[] expected = { "schemaVersion", "candidate", "commitSha", "buildMs", "toolchainVersion" };
        if (members.Count != expected.Length) throw new FormatException();
        foreach (string name in expected)
        {
            if (!members.ContainsKey(name)) throw new FormatException();
        }

        int schemaVersion;
        double buildMs;
        if (members["schemaVersion"].Kind != JsonValueKind.Number ||
            !Int32.TryParse(members["schemaVersion"].Text, NumberStyles.None, CultureInfo.InvariantCulture, out schemaVersion) ||
            schemaVersion != 1 ||
            members["candidate"].Kind != JsonValueKind.String || members["candidate"].Text != expectedCandidate ||
            members["commitSha"].Kind != JsonValueKind.String ||
            !Regex.IsMatch(members["commitSha"].Text, "\\A[0-9a-f]{40}\\z", RegexOptions.CultureInvariant) ||
            members["buildMs"].Kind != JsonValueKind.Number ||
            !Double.TryParse(members["buildMs"].Text, NumberStyles.Float, CultureInfo.InvariantCulture, out buildMs) ||
            Double.IsNaN(buildMs) || Double.IsInfinity(buildMs) || buildMs < 0 ||
            members["toolchainVersion"].Kind != JsonValueKind.String ||
            String.IsNullOrWhiteSpace(members["toolchainVersion"].Text))
        {
            throw new FormatException();
        }

        return new LauncherBuildMetadata
        {
            SchemaVersion = schemaVersion,
            Candidate = members["candidate"].Text,
            CommitSha = members["commitSha"].Text,
            BuildMs = buildMs,
            ToolchainVersion = members["toolchainVersion"].Text,
        };
    }
}

public enum JsonValueKind
{
    String,
    Number,
}

public sealed class JsonValue
{
    public JsonValueKind Kind { get; private set; }
    public string Text { get; private set; }

    public JsonValue(JsonValueKind kind, string text)
    {
        Kind = kind;
        Text = text;
    }
}

public sealed class StrictJsonReader
{
    private readonly string json;
    private int position;

    public StrictJsonReader(string json)
    {
        if (json == null) throw new ArgumentNullException("json");
        this.json = json;
    }

    public Dictionary<string, JsonValue> ReadObject()
    {
        var members = new Dictionary<string, JsonValue>(StringComparer.Ordinal);
        SkipWhitespace();
        Expect('{');
        SkipWhitespace();
        if (TryRead('}'))
        {
            SkipWhitespace();
            RequireEnd();
            return members;
        }

        while (true)
        {
            string name = ReadString();
            if (members.ContainsKey(name)) throw new FormatException("duplicate member");
            SkipWhitespace();
            Expect(':');
            SkipWhitespace();
            members.Add(name, ReadValue());
            SkipWhitespace();
            if (TryRead('}')) break;
            Expect(',');
            SkipWhitespace();
        }

        SkipWhitespace();
        RequireEnd();
        return members;
    }

    private JsonValue ReadValue()
    {
        if (Peek() == '"')
        {
            return new JsonValue(JsonValueKind.String, ReadString());
        }
        return new JsonValue(JsonValueKind.Number, ReadNumber());
    }

    private string ReadString()
    {
        Expect('"');
        var value = new StringBuilder();
        while (position < json.Length)
        {
            char current = json[position++];
            if (current == '"') return value.ToString();
            if (current < 0x20) throw new FormatException();
            if (current != '\\')
            {
                value.Append(current);
                continue;
            }

            if (position >= json.Length) throw new FormatException();
            char escaped = json[position++];
            switch (escaped)
            {
                case '"': value.Append('"'); break;
                case '\\': value.Append('\\'); break;
                case '/': value.Append('/'); break;
                case 'b': value.Append('\b'); break;
                case 'f': value.Append('\f'); break;
                case 'n': value.Append('\n'); break;
                case 'r': value.Append('\r'); break;
                case 't': value.Append('\t'); break;
                case 'u': value.Append(ReadUnicodeEscape()); break;
                default: throw new FormatException("invalid escape");
            }
        }
        throw new FormatException();
    }

    private char ReadUnicodeEscape()
    {
        if (position + 4 > json.Length) throw new FormatException();
        int value = 0;
        for (int index = 0; index < 4; index++)
        {
            char digit = json[position++];
            value <<= 4;
            if (digit >= '0' && digit <= '9') value += digit - '0';
            else if (digit >= 'a' && digit <= 'f') value += digit - 'a' + 10;
            else if (digit >= 'A' && digit <= 'F') value += digit - 'A' + 10;
            else throw new FormatException();
        }
        return (char)value;
    }

    private string ReadNumber()
    {
        int start = position;
        TryRead('-');
        if (TryRead('0'))
        {
            if (IsDigit(Peek())) throw new FormatException();
        }
        else
        {
            RequireDigit('1', '9');
            while (IsDigit(Peek())) position++;
        }

        if (TryRead('.'))
        {
            RequireDigit('0', '9');
            while (IsDigit(Peek())) position++;
        }
        char exponent = Peek();
        if (exponent == 'e' || exponent == 'E')
        {
            position++;
            char sign = Peek();
            if (sign == '+' || sign == '-') position++;
            RequireDigit('0', '9');
            while (IsDigit(Peek())) position++;
        }
        return json.Substring(start, position - start);
    }

    private void SkipWhitespace()
    {
        while (position < json.Length)
        {
            char current = json[position];
            if (current != ' ' && current != '\t' && current != '\r' && current != '\n') return;
            position++;
        }
    }

    private char Peek()
    {
        return position < json.Length ? json[position] : '\0';
    }

    private bool TryRead(char expected)
    {
        if (Peek() != expected) return false;
        position++;
        return true;
    }

    private void Expect(char expected)
    {
        if (!TryRead(expected)) throw new FormatException();
    }

    private void RequireDigit(char minimum, char maximum)
    {
        char current = Peek();
        if (current < minimum || current > maximum) throw new FormatException();
        position++;
    }

    private static bool IsDigit(char value)
    {
        return value >= '0' && value <= '9';
    }

    private void RequireEnd()
    {
        if (position != json.Length) throw new FormatException();
    }
}
'@

$processJobSource = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public sealed class LauncherProcessJob : IDisposable
{
    private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const Int32 JobObjectExtendedLimitInformation = 9;
    private IntPtr handle;

    public LauncherProcessJob()
    {
        handle = CreateJobObjectW(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw LastWin32Exception();

        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (UInt32)size))
            {
                int error = Marshal.GetLastWin32Error();
                if (CloseHandle(handle)) handle = IntPtr.Zero;
                throw new Win32Exception(error);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public LauncherNativeProcess PrepareProcess(
        string filePath, string commandLine, string pathOverride)
    {
        if (handle == IntPtr.Zero) throw new ObjectDisposedException("LauncherProcessJob");
        return new LauncherNativeProcess(handle, filePath, commandLine, pathOverride);
    }

    public void Dispose()
    {
        IntPtr value = handle;
        if (value != IntPtr.Zero && !CloseHandle(value)) throw LastWin32Exception();
        handle = IntPtr.Zero;
        GC.SuppressFinalize(this);
    }

    ~LauncherProcessJob()
    {
        if (handle != IntPtr.Zero) CloseHandle(handle);
    }

    private static Win32Exception LastWin32Exception()
    {
        return new Win32Exception(Marshal.GetLastWin32Error());
    }

    public sealed class LauncherNativeProcess : IDisposable
    {
        private const UInt32 CREATE_SUSPENDED = 0x00000004;
        private const UInt32 CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const UInt32 EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const UInt32 CREATE_NO_WINDOW = 0x08000000;
        private const UInt32 STARTF_USESTDHANDLES = 0x00000100;
        private const UInt32 HANDLE_FLAG_INHERIT = 0x00000001;
        private const Int32 PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private const UInt32 GENERIC_READ = 0x80000000;
        private const UInt32 FILE_SHARE_READ = 0x00000001;
        private const UInt32 FILE_SHARE_WRITE = 0x00000002;
        private const UInt32 OPEN_EXISTING = 3;
        private const UInt32 FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const UInt32 WAIT_OBJECT_0 = 0x00000000;
        private const UInt32 WAIT_TIMEOUT = 0x00000102;
        private const UInt32 WAIT_FAILED = 0xFFFFFFFF;
        private const UInt32 STILL_ACTIVE = 259;
        private const UInt32 PROCESS_CREATION_FLAGS = CREATE_SUSPENDED |
            CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;

        private readonly IntPtr jobHandle;
        private readonly string filePath;
        private readonly StringBuilder commandLine;
        private IntPtr environmentBlock;
        private IntPtr attributeList;
        private IntPtr handleList;
        private bool attributeListInitialized;
        private IntPtr stdinHandle;
        private IntPtr stdoutReadHandle;
        private IntPtr stdoutWriteHandle;
        private IntPtr stderrReadHandle;
        private IntPtr stderrWriteHandle;
        private IntPtr processHandle;
        private IntPtr threadHandle;
        private STARTUPINFOEX startupInfo;
        private PROCESS_INFORMATION processInformation;
        private SafeFileHandle stdoutSafeHandle;
        private SafeFileHandle stderrSafeHandle;
        private StreamReader stdoutReader;
        private StreamReader stderrReader;
        private readonly CountdownEvent captureReady = new CountdownEvent(2);
        private bool capturePrepared;
        private bool started;
        private bool disposed;

        public Task<string> StdoutTask { get; private set; }
        public Task<string> StderrTask { get; private set; }

        internal LauncherNativeProcess(
            IntPtr jobHandle, string filePath, string commandLine, string pathOverride)
        {
            this.jobHandle = jobHandle;
            this.filePath = filePath;
            this.commandLine = new StringBuilder(commandLine);
            try
            {
                environmentBlock = BuildEnvironmentBlock(pathOverride);
                PreparePipesAndAttributes();
            }
            catch
            {
                try { if (stdoutReader != null) stdoutReader.Dispose(); } catch { }
                try { if (stderrReader != null) stderrReader.Dispose(); } catch { }
                try { if (stdoutSafeHandle != null) stdoutSafeHandle.Dispose(); } catch { }
                try { if (stderrSafeHandle != null) stderrSafeHandle.Dispose(); } catch { }
                try { captureReady.Dispose(); } catch { }
                CleanupHandles(false);
                throw;
            }
        }

        public void PrepareCapture()
        {
            if (disposed || started || capturePrepared) throw new InvalidOperationException();
            StdoutTask = Task.Factory.StartNew(
                () => { captureReady.Signal(); return stdoutReader.ReadToEnd(); },
                TaskCreationOptions.LongRunning);
            StderrTask = Task.Factory.StartNew(
                () => { captureReady.Signal(); return stderrReader.ReadToEnd(); },
                TaskCreationOptions.LongRunning);
            if (!captureReady.Wait(5000)) throw new Win32Exception(1460);
            capturePrepared = true;
        }

        public void Start()
        {
            if (disposed || started || !capturePrepared) throw new InvalidOperationException();
            if (!CreateProcessW(
                filePath, commandLine, IntPtr.Zero, IntPtr.Zero, true, PROCESS_CREATION_FLAGS,
                environmentBlock, null, ref startupInfo, out processInformation))
            {
                throw LastWin32Exception();
            }
            processHandle = processInformation.hProcess;
            threadHandle = processInformation.hThread;
            started = true;

            try
            {
                CloseParentWriteHandles();
                if (!AssignProcessToJobObject(jobHandle, processHandle))
                {
                    int error = Marshal.GetLastWin32Error();
                    TerminateSuspendedProcess();
                    throw new Win32Exception(error);
                }
                if (ResumeThread(threadHandle) == UInt32.MaxValue)
                {
                    int error = Marshal.GetLastWin32Error();
                    TerminateSuspendedProcess();
                    throw new Win32Exception(error);
                }
            }
            catch
            {
                if (IsProcessActive()) TerminateSuspendedProcess();
                throw;
            }
        }

        public bool WaitForExit(int timeoutMs)
        {
            UInt32 result = WaitForSingleObject(processHandle, (UInt32)timeoutMs);
            if (result == WAIT_OBJECT_0) return true;
            if (result == WAIT_TIMEOUT) return false;
            if (result == WAIT_FAILED) throw LastWin32Exception();
            throw new Win32Exception();
        }

        public int ExitCode
        {
            get
            {
                UInt32 exitCode;
                if (!GetExitCodeProcess(processHandle, out exitCode)) throw LastWin32Exception();
                if (exitCode == STILL_ACTIVE) throw new InvalidOperationException();
                return unchecked((Int32)exitCode);
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            Exception failure = null;
            try { CloseParentWriteHandles(); } catch (Exception error) { failure = error; }
            try { WaitForCaptureTasks(5000); } catch (Exception error) { if (failure == null) failure = error; }
            try { if (stdoutReader != null) stdoutReader.Dispose(); } catch (Exception error) { if (failure == null) failure = error; }
            try { if (stderrReader != null) stderrReader.Dispose(); } catch (Exception error) { if (failure == null) failure = error; }
            try { if (stdoutSafeHandle != null) stdoutSafeHandle.Dispose(); } catch (Exception error) { if (failure == null) failure = error; }
            try { if (stderrSafeHandle != null) stderrSafeHandle.Dispose(); } catch (Exception error) { if (failure == null) failure = error; }
            try { captureReady.Dispose(); } catch (Exception error) { if (failure == null) failure = error; }
            try { CleanupHandles(true); } catch (Exception error) { if (failure == null) failure = error; }
            if (failure != null) throw failure;
            GC.SuppressFinalize(this);
        }

        ~LauncherNativeProcess()
        {
            CleanupHandles(false);
        }

        private void PreparePipesAndAttributes()
        {
            var security = new SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.bInheritHandle = true;
            if (!CreatePipe(out stdoutReadHandle, out stdoutWriteHandle, ref security, 0))
                throw LastWin32Exception();
            if (!SetHandleInformation(stdoutReadHandle, HANDLE_FLAG_INHERIT, 0))
                throw LastWin32Exception();
            if (!CreatePipe(out stderrReadHandle, out stderrWriteHandle, ref security, 0))
                throw LastWin32Exception();
            if (!SetHandleInformation(stderrReadHandle, HANDLE_FLAG_INHERIT, 0))
                throw LastWin32Exception();
            stdinHandle = CreateFileW(
                "NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref security,
                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (stdinHandle == new IntPtr(-1)) throw LastWin32Exception();

            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == UIntPtr.Zero) throw LastWin32Exception();
            attributeList = Marshal.AllocHGlobal(checked((Int32)size.ToUInt64()));
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size))
                throw LastWin32Exception();
            attributeListInitialized = true;
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, stdinHandle);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, stdoutWriteHandle);
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderrWriteHandle);
            if (!UpdateProcThreadAttribute(
                attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
            {
                throw LastWin32Exception();
            }

            startupInfo = new STARTUPINFOEX();
            startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startupInfo.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startupInfo.StartupInfo.hStdInput = stdinHandle;
            startupInfo.StartupInfo.hStdOutput = stdoutWriteHandle;
            startupInfo.StartupInfo.hStdError = stderrWriteHandle;
            startupInfo.lpAttributeList = attributeList;

            stdoutSafeHandle = new SafeFileHandle(stdoutReadHandle, true);
            stdoutReadHandle = IntPtr.Zero;
            stderrSafeHandle = new SafeFileHandle(stderrReadHandle, true);
            stderrReadHandle = IntPtr.Zero;
            stdoutReader = new StreamReader(new FileStream(stdoutSafeHandle, FileAccess.Read, 4096, false), new UTF8Encoding(false, true));
            stderrReader = new StreamReader(new FileStream(stderrSafeHandle, FileAccess.Read, 4096, false), new UTF8Encoding(false, true));
        }

        private static IntPtr BuildEnvironmentBlock(string pathOverride)
        {
            IDictionary environment = Environment.GetEnvironmentVariables();
            var entries = new List<string>();
            bool replacedPath = false;
            foreach (DictionaryEntry entry in environment)
            {
                string name = (string)entry.Key;
                string value = (string)entry.Value;
                if (pathOverride != null && String.Equals(name, "PATH", StringComparison.OrdinalIgnoreCase))
                {
                    value = pathOverride;
                    replacedPath = true;
                }
                entries.Add(name + "=" + value);
            }
            if (pathOverride != null && !replacedPath) entries.Add("PATH=" + pathOverride);
            entries.Sort(StringComparer.OrdinalIgnoreCase);
            var block = new StringBuilder();
            foreach (string entry in entries) block.Append(entry).Append('\0');
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }

        private void CloseParentWriteHandles()
        {
            Exception failure = null;
            TryClose(ref stdinHandle, ref failure);
            TryClose(ref stdoutWriteHandle, ref failure);
            TryClose(ref stderrWriteHandle, ref failure);
            if (failure != null) throw failure;
        }

        private void WaitForCaptureTasks(int timeoutMs)
        {
            var tasks = new List<Task>();
            if (StdoutTask != null) tasks.Add(StdoutTask);
            if (StderrTask != null) tasks.Add(StderrTask);
            if (tasks.Count != 0 && !Task.WaitAll(tasks.ToArray(), timeoutMs))
                throw new Win32Exception(1460);
        }

        private void TerminateSuspendedProcess()
        {
            if (processHandle == IntPtr.Zero) return;
            if (!TerminateProcess(processHandle, 1) && IsProcessActive()) throw LastWin32Exception();
            UInt32 result = WaitForSingleObject(processHandle, 5000);
            if (result == WAIT_OBJECT_0) return;
            if (result == WAIT_FAILED) throw LastWin32Exception();
            throw new Win32Exception(1460);
        }

        private bool IsProcessActive()
        {
            if (processHandle == IntPtr.Zero) return false;
            UInt32 exitCode;
            if (!GetExitCodeProcess(processHandle, out exitCode)) throw LastWin32Exception();
            return exitCode == STILL_ACTIVE;
        }

        private void CleanupHandles(bool throwOnFailure)
        {
            Exception failure = null;
            TryClose(ref threadHandle, ref failure);
            TryClose(ref processHandle, ref failure);
            TryClose(ref stdinHandle, ref failure);
            TryClose(ref stdoutReadHandle, ref failure);
            TryClose(ref stdoutWriteHandle, ref failure);
            TryClose(ref stderrReadHandle, ref failure);
            TryClose(ref stderrWriteHandle, ref failure);
            if (attributeList != IntPtr.Zero)
            {
                if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
                attributeList = IntPtr.Zero;
                attributeListInitialized = false;
            }
            if (handleList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handleList);
                handleList = IntPtr.Zero;
            }
            if (environmentBlock != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(environmentBlock);
                environmentBlock = IntPtr.Zero;
            }
            if (throwOnFailure && failure != null) throw failure;
        }

        private static void TryClose(ref IntPtr value, ref Exception failure)
        {
            if (value == IntPtr.Zero || value == new IntPtr(-1))
            {
                value = IntPtr.Zero;
                return;
            }
            if (CloseHandle(value))
            {
                value = IntPtr.Zero;
            }
            else if (failure == null)
            {
                failure = LastWin32Exception();
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName, StringBuilder commandLine, IntPtr processAttributes,
            IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            UInt32 creationFlags, IntPtr environment, string currentDirectory,
            ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreatePipe(
            out IntPtr readPipe, out IntPtr writePipe,
            ref SECURITY_ATTRIBUTES pipeAttributes, UInt32 size);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(IntPtr handle, UInt32 mask, UInt32 flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName, UInt32 desiredAccess, UInt32 shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes, UInt32 creationDisposition,
            UInt32 flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList, Int32 attributeCount, Int32 flags, ref UIntPtr size);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList, UInt32 flags, IntPtr attribute, IntPtr value,
            IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern UInt32 ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, UInt32 exitCode);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out UInt32 exitCode);

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public Int32 nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public Int32 cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public Int32 dwX;
            public Int32 dwY;
            public Int32 dwXSize;
            public Int32 dwYSize;
            public Int32 dwXCountChars;
            public Int32 dwYCountChars;
            public Int32 dwFillAttribute;
            public UInt32 dwFlags;
            public UInt16 wShowWindow;
            public UInt16 cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public UInt32 dwProcessId;
            public UInt32 dwThreadId;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job, Int32 informationClass, IntPtr information, UInt32 informationLength);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
'@

function Initialize-ProcessJob {
    if ('LauncherProcessJob' -as [type]) {
        return
    }
    try {
        Add-Type -TypeDefinition $processJobSource
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_JOB_FAILED'
    }
}

function Initialize-BuildMetadataParser {
    if ('LauncherBuildMetadataParser' -as [type]) {
        return
    }
    Add-Type -TypeDefinition $metadataParserSource
}

function Throw-BenchmarkError {
    param([Parameter(Mandatory)][string]$Code)
    throw [LauncherBenchmarkError]::new($Code)
}

function Get-CanonicalAbsolutePath {
    param([Parameter(Mandatory)][string]$InputPath)

    if ([string]::IsNullOrWhiteSpace($InputPath)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    try {
        if ((Get-Location).Provider.Name -ne 'FileSystem') {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
        }
        $workingDirectory = (Get-Location).ProviderPath
        if ([IO.Path]::IsPathRooted($InputPath)) {
            return [IO.Path]::GetFullPath($InputPath)
        }
        return [IO.Path]::GetFullPath([IO.Path]::Combine($workingDirectory, $InputPath))
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
}

function Assert-NoReparsePath {
    param([Parameter(Mandatory)][System.IO.FileSystemInfo]$Item)

    $current = $Item
    while ($null -ne $current) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
        }
        $current = if ($current -is [IO.FileInfo]) { $current.Directory } else { $current.Parent }
    }
}

function Assert-RegularExecutable {
    param([Parameter(Mandatory)][string]$ExecutablePath)

    $absolutePath = Get-CanonicalAbsolutePath $ExecutablePath
    try {
        $item = Get-Item -LiteralPath $absolutePath
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_EXECUTABLE'
    }
    if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer -or $item.Length -le 0) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_EXECUTABLE'
    }
    Assert-NoReparsePath $item
    return $item.FullName
}

function Assert-SafeOutputPath {
    param([Parameter(Mandatory)][string]$RequestedPath)

    $absolutePath = Get-CanonicalAbsolutePath $RequestedPath
    $leaf = [IO.Path]::GetFileName($absolutePath)
    if ([string]::IsNullOrWhiteSpace($leaf) -or
        $leaf.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
        $leaf -cne $leaf.TrimEnd(' ', '.')) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    if (Test-Path -LiteralPath $absolutePath) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_OUTPUT_EXISTS'
    }
    $parentPath = [IO.Path]::GetDirectoryName($absolutePath)
    if ([string]::IsNullOrEmpty($parentPath)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    try {
        $parent = Get-Item -LiteralPath $parentPath
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    if ($parent.PSProvider.Name -ne 'FileSystem' -or -not $parent.PSIsContainer) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_PATH'
    }
    Assert-NoReparsePath $parent
    return $absolutePath
}

function Read-BuildMetadata {
    param(
        [Parameter(Mandatory)][string]$ExecutablePath,
        [Parameter(Mandatory)][ValidateSet('go', 'dotnet')][string]$Candidate
    )

    $sidecarPath = $ExecutablePath + '.build.json'
    try {
        Initialize-BuildMetadataParser
    }
    catch {
        if ($env:LAUNCHER_BENCHMARK_BEHAVIOR_DIAGNOSTICS -ceq '1') {
            [Console]::Error.WriteLine('LAUNCHER_BENCHMARK_METADATA_PARSER_INIT')
        }
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA'
    }
    try {
        $sidecarItem = Get-Item -LiteralPath $sidecarPath
        if ($sidecarItem.PSProvider.Name -ne 'FileSystem' -or $sidecarItem.PSIsContainer) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA'
        }
        Assert-NoReparsePath $sidecarItem
        return [LauncherBuildMetadataParser]::Parse($sidecarItem.FullName, $Candidate)
    }
    catch {
        if ($env:LAUNCHER_BENCHMARK_BEHAVIOR_DIAGNOSTICS -ceq '1') {
            [Console]::Error.WriteLine('LAUNCHER_BENCHMARK_METADATA_PARSER_PARSE')
        }
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_BUILD_METADATA'
    }
}

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Argument)

    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
        return $Argument
    }
    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * ($backslashes * 2 + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][int]$TimeoutMs,
        [AllowNull()][string]$PathOverride
    )

    $commandLineParts = @((ConvertTo-WindowsCommandLineArgument $FilePath))
    $commandLineParts += @($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ })
    $commandLine = [string]::Join(' ', $commandLineParts)
    $job = $null
    $runner = $null
    $stopwatch = $null
    try {
        Initialize-ProcessJob
        try {
            $job = [LauncherProcessJob]::new()
        }
        catch {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_JOB_FAILED'
        }
        try {
            $runner = $job.PrepareProcess($FilePath, $commandLine, $PathOverride)
        }
        catch {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_JOB_FAILED'
        }
        $runner.PrepareCapture()
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $runner.Start()
        $stdoutTask = $runner.StdoutTask
        $stderrTask = $runner.StderrTask
        if (-not $runner.WaitForExit($TimeoutMs)) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_TIMEOUT'
        }
        $CaptureTimeoutMs = 5000
        $captureTasks = [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)
        if (-not [Threading.Tasks.Task]::WaitAll($captureTasks, $CaptureTimeoutMs)) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_CAPTURE_TIMEOUT'
        }
        $stopwatch.Stop()
        return [pscustomobject]@{
            ExitCode = $runner.ExitCode
            Stdout = $stdoutTask.GetAwaiter().GetResult()
            Stderr = $stderrTask.GetAwaiter().GetResult()
            ElapsedMs = $stopwatch.Elapsed.TotalMilliseconds
        }
    }
    catch [LauncherBenchmarkError] {
        throw
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_JOB_FAILED'
    }
    finally {
        if ($null -ne $stopwatch) {
            $stopwatch.Stop()
        }
        $jobDisposeFailed = $false
        if ($null -ne $job) {
            try { $job.Dispose() } catch { $jobDisposeFailed = $true }
        }
        if ($null -ne $runner) {
            try { $runner.Dispose() } catch { $jobDisposeFailed = $true }
        }
        if ($jobDisposeFailed) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_JOB_FAILED'
        }
    }
}

function Resolve-CommitSha {
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) {
        if ($env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$') {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_COMMIT'
        }
        return $env:GITHUB_SHA
    }

    try {
        $git = Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $result = Invoke-CapturedProcess $git.Source @('rev-parse', 'HEAD') 10000 $null
        $sha = $result.Stdout.Trim()
    }
    catch [LauncherBenchmarkError] {
        throw
    }
    catch {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_COMMIT'
    }
    if ($result.ExitCode -ne 0 -or $result.Stderr.Length -ne 0 -or $sha -cnotmatch '^[0-9a-f]{40}$') {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_INVALID_COMMIT'
    }
    return $sha
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][byte[]]$Bytes)

    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $hasher.ComputeHash($Bytes)
        return [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $json = $Value | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function New-ManifestFixture {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Archive,
        [Parameter(Mandatory)][byte[]]$Payload,
        [string]$HashOverride
    )

    $caseRoot = Join-Path $Root $Name
    [void][IO.Directory]::CreateDirectory($caseRoot)
    if ($Archive -notmatch '^(?:[A-Za-z]:|\\\\|/|\.\.)') {
        $archivePath = Join-Path $caseRoot ($Archive.Replace('\', [IO.Path]::DirectorySeparatorChar))
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($archivePath))
        [IO.File]::WriteAllBytes($archivePath, $Payload)
    }
    $hash = if ([string]::IsNullOrEmpty($HashOverride)) { Get-Sha256Hex $Payload } else { $HashOverride }
    $manifestPath = Join-Path $caseRoot 'launcher-manifest.json'
    Write-Utf8Json $manifestPath ([ordered]@{
        runtimeId = 'openclaw-2026.7.1-2-win-x64'
        archive = $Archive
        sha256 = $hash
    })
    return $manifestPath
}

function New-CandidateFixtures {
    param([Parameter(Mandatory)][string]$Root)

    $payload = [Text.Encoding]::UTF8.GetBytes('equivalent launcher benchmark payload')
    $unicodeRoot = Join-Path $Root 'unicode 空间'
    [void][IO.Directory]::CreateDirectory($unicodeRoot)
    return [ordered]@{
        'valid-manifest' = New-ManifestFixture $Root 'valid-manifest' 'packages\runtime package.pkg' $payload
        'invalid-sha256' = New-ManifestFixture $Root 'invalid-sha256' 'packages\runtime.pkg' $payload ('0' * 64)
        'path-traversal' = New-ManifestFixture $Root 'path-traversal' '..\outside.pkg' $payload
        'absolute-path' = New-ManifestFixture $Root 'absolute-path' 'C:\benchmark\runtime.pkg' $payload
        'absolute-path-unc' = New-ManifestFixture $Root 'absolute-path-unc' '\\benchmark-host\share\runtime.pkg' $payload
        'unicode-space-path' = New-ManifestFixture $unicodeRoot 'valid' 'packages\runtime package.pkg' $payload
        'sdk-path-removed' = New-ManifestFixture $Root 'sdk-path-removed' 'packages\runtime.pkg' $payload
    }
}

function Test-ExpectedInvocation {
    param(
        [Parameter(Mandatory)]$Candidate,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][int]$ExpectedExitCode,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedStdout,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedStderr,
        [AllowNull()][string]$PathOverride
    )

    try {
        $result = Invoke-CapturedProcess $Candidate.Executable $Arguments 15000 $PathOverride
        return $result.ExitCode -eq $ExpectedExitCode -and
            $result.Stdout -ceq $ExpectedStdout -and
            $result.Stderr -ceq $ExpectedStderr
    }
    catch {
        return $false
    }
}

function Get-NormalizedPathSegment {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Segment)

    $trimmed = $Segment.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $null
    }
    try {
        $expanded = [Environment]::ExpandEnvironmentVariables($trimmed)
        $normalized = [IO.Path]::GetFullPath($expanded)
        $root = [IO.Path]::GetPathRoot($normalized)
        if ($normalized -cne $root) {
            $normalized = $normalized.TrimEnd('\', '/')
        }
        return $normalized
    }
    catch {
        return $null
    }
}

function Get-SdkFreePath {
    $sdkDirectories = @()
    foreach ($commandName in @('go', 'dotnet')) {
        @(Get-Command $commandName -CommandType Application -All -ErrorAction SilentlyContinue) | ForEach-Object {
            $directory = Get-NormalizedPathSegment ([IO.Path]::GetDirectoryName($_.Source))
            if ($null -ne $directory -and -not ($sdkDirectories -contains $directory)) {
                $sdkDirectories += $directory
            }
        }
    }
    $separator = [IO.Path]::PathSeparator
    $segments = @($env:PATH.Split($separator) | ForEach-Object {
        $normalized = Get-NormalizedPathSegment $_
        if ($null -ne $normalized -and -not ($sdkDirectories -contains $normalized)) {
            $normalized
        }
    })
    return [string]::Join($separator, $segments)
}

function Invoke-WithoutSdkPath {
    param([Parameter(Mandatory)][scriptblock]$Operation)

    $originalPath = $env:PATH
    try {
        $env:PATH = Get-SdkFreePath
        $remainingSdkCommands = @(Get-Command @('go', 'dotnet') -CommandType Application -ErrorAction SilentlyContinue)
        if ($remainingSdkCommands.Count -ne 0) {
            return $false
        }
        return & $Operation $env:PATH
    }
    finally {
        $env:PATH = $originalPath
    }
}

function Get-CandidateNewline {
    param([Parameter(Mandatory)][ValidateSet('go', 'dotnet')][string]$CandidateId)

    if ($CandidateId -ceq 'go') {
        return "`n"
    }
    return [Environment]::NewLine
}

function Test-ReadyJson {
    param(
        [Parameter(Mandatory)][string]$Output,
        [Parameter(Mandatory)][string]$CandidateId
    )

    $expected = '{"status":"ready","candidate":"' + $CandidateId + '"}' + (Get-CandidateNewline $CandidateId)
    if ($Output -cne $expected) {
        return $false
    }
    try {
        $ready = $Output.TrimEnd("`r", "`n") | ConvertFrom-Json
        return $ready.status -ceq 'ready' -and $ready.candidate -ceq $CandidateId -and
            @($ready.PSObject.Properties).Count -eq 2
    }
    catch {
        return $false
    }
}

function Invoke-MandatoryCases {
    param(
        [Parameter(Mandatory)]$Candidate,
        [Parameter(Mandatory)]$Fixtures
    )

    $newline = Get-CandidateNewline $Candidate.Id
    $ready = '{"status":"ready","candidate":"' + $Candidate.Id + '"}' + $newline
    $cases = [ordered]@{}
    $cases['valid-manifest'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['valid-manifest']) 0 $ready '' $null
    $cases['invalid-sha256'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['invalid-sha256']) 1 '' ('E_PACKAGE_INVALID' + $newline) $null
    $cases['path-traversal'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['path-traversal']) 1 '' ('E_MANIFEST_INVALID' + $newline) $null
    $cases['absolute-path'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['absolute-path']) 1 '' ('E_MANIFEST_INVALID' + $newline) $null
    $cases['absolute-path-unc'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['absolute-path-unc']) 1 '' ('E_MANIFEST_INVALID' + $newline) $null
    $cases['unicode-space-path'] = Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['unicode-space-path']) 0 $ready '' $null
    $cases['sdk-path-removed'] = Invoke-WithoutSdkPath {
        param($sdkFreePath)
        Test-ExpectedInvocation $Candidate @('--manifest', $Fixtures['sdk-path-removed']) 0 $ready '' $sdkFreePath
    }
    $cases['cli-invalid-arguments'] = Test-ExpectedInvocation $Candidate @('--private-secret-path') 1 '' ('E_ARGUMENTS' + $newline) $null
    return $cases
}

function Get-Percentile {
    param(
        [Parameter(Mandatory)][double[]]$Values,
        [Parameter(Mandatory)][ValidateRange(0.0, 1.0)][double]$Percentile
    )

    $sorted = @($Values | Sort-Object)
    $index = [Math]::Ceiling($Percentile * $sorted.Count) - 1
    return $sorted[[Math]::Max(0, $index)]
}

function Invoke-TimedReady {
    param(
        [Parameter(Mandatory)]$Candidate,
        [Parameter(Mandatory)][string]$ManifestPath
    )

    $result = Invoke-CapturedProcess $Candidate.Executable @('--manifest', $ManifestPath) 15000 $null
    if ($result.ExitCode -ne 0 -or $result.Stderr.Length -ne 0 -or
        -not (Test-ReadyJson $result.Stdout $Candidate.Id)) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_PROCESS_FAILED'
    }
    return $result.ElapsedMs
}

function Write-AtomicReport {
    param(
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)]$Report
    )

    $directory = [IO.Path]::GetDirectoryName($Destination)
    $temporaryPath = Join-Path $directory ('.launcher-benchmark-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Report | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
    try {
        $stream = [IO.FileStream]::new($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        [IO.File]::Move($temporaryPath, $Destination)
    }
    catch [IO.IOException] {
        if (Test-Path -LiteralPath $Destination) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_OUTPUT_EXISTS'
        }
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_IO_ERROR'
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
    }
}

function Assert-SafeReportValue {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value -match '[A-Za-z]:[\\/]|\\\\|/(?:Users|home|tmp)/') {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_REPORT'
    }
    foreach ($forbidden in @($env:USERNAME, [IO.Path]::GetTempPath())) {
        if (-not [string]::IsNullOrWhiteSpace($forbidden) -and
            $Value.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Throw-BenchmarkError 'LAUNCHER_BENCHMARK_UNSAFE_REPORT'
        }
    }
}

function Invoke-LauncherBenchmark {
    $safeGoExe = Assert-RegularExecutable $GoExe
    $safeDotnetExe = Assert-RegularExecutable $DotnetExe
    $safeOutputPath = Assert-SafeOutputPath $OutputPath
    $commitSha = Resolve-CommitSha
    $goMetadata = Read-BuildMetadata $safeGoExe 'go'
    $dotnetMetadata = Read-BuildMetadata $safeDotnetExe 'dotnet'
    if ($goMetadata.commitSha -cne $commitSha -or $dotnetMetadata.commitSha -cne $commitSha) {
        Throw-BenchmarkError 'LAUNCHER_BENCHMARK_COMMIT_MISMATCH'
    }

    $candidates = @(
        [pscustomobject]@{ Id = 'go'; Executable = $safeGoExe; Metadata = $goMetadata },
        [pscustomobject]@{ Id = 'dotnet'; Executable = $safeDotnetExe; Metadata = $dotnetMetadata }
    )
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('uclaw-launcher-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($temporaryRoot)
    try {
        $fixturesByCandidate = @{}
        $caseResults = @{}
        $timings = @{ go = [Collections.Generic.List[double]]::new(); dotnet = [Collections.Generic.List[double]]::new() }
        foreach ($candidate in $candidates) {
            $candidateRoot = Join-Path $temporaryRoot $candidate.Id
            [void][IO.Directory]::CreateDirectory($candidateRoot)
            $fixturesByCandidate[$candidate.Id] = New-CandidateFixtures $candidateRoot
            $caseResults[$candidate.Id] = Invoke-MandatoryCases $candidate $fixturesByCandidate[$candidate.Id]
        }

        foreach ($candidate in $candidates) {
            [void](Invoke-TimedReady $candidate $fixturesByCandidate[$candidate.Id]['valid-manifest'])
        }
        for ($iteration = 0; $iteration -lt $Iterations; $iteration++) {
            $iterationCandidates = if ($iteration % 2 -eq 0) { $candidates } else { @($candidates[1], $candidates[0]) }
            foreach ($candidate in $iterationCandidates) {
                $elapsed = Invoke-TimedReady $candidate $fixturesByCandidate[$candidate.Id]['valid-manifest']
                $timings[$candidate.Id].Add($elapsed)
            }
        }

        $candidateReports = [ordered]@{}
        foreach ($candidate in $candidates) {
            $cases = $caseResults[$candidate.Id]
            $mandatoryPassed = -not ($cases.Values -contains $false)
            Assert-SafeReportValue $candidate.Metadata.toolchainVersion
            $candidateReports[$candidate.Id] = [ordered]@{
                exeBytes = [int64](Get-Item -LiteralPath $candidate.Executable).Length
                buildMs = [double]$candidate.Metadata.buildMs
                p50Ms = [Math]::Round((Get-Percentile $timings[$candidate.Id].ToArray() 0.50), 6)
                p95Ms = [Math]::Round((Get-Percentile $timings[$candidate.Id].ToArray() 0.95), 6)
                mandatoryPassed = $mandatoryPassed
                cases = $cases
                toolchainVersion = $candidate.Metadata.toolchainVersion
            }
        }

        $cpu = if ([string]::IsNullOrWhiteSpace($env:PROCESSOR_IDENTIFIER)) { 'unknown-windows-cpu' } else { $env:PROCESSOR_IDENTIFIER }
        Assert-SafeReportValue $cpu
        $report = [ordered]@{
            schemaVersion = 1
            trial = $Trial
            measurementKind = 'hosted-runner-process-start'
            commitSha = $commitSha
            runner = [ordered]@{ os = 'Windows'; arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); cpu = $cpu }
            candidates = $candidateReports
        }
        Write-AtomicReport $safeOutputPath $report
    }
    finally {
        if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse }
    }
}

try {
    Invoke-LauncherBenchmark
}
catch [LauncherBenchmarkError] {
    [Console]::Error.WriteLine(($_.Exception.ErrorCode + ': benchmark failed'))
    exit 1
}
catch {
    [Console]::Error.WriteLine('LAUNCHER_BENCHMARK_INTERNAL_ERROR: benchmark failed')
    exit 1
}
