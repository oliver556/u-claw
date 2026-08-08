using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

internal static class ManifestValidatorTests
{
    public static void RunAll()
    {
        ValidateManifestAcceptsContractValues();
        ValidateManifestRejectsInvalidRuntimeIds();
        ValidateManifestRejectsUnsafeArchives();
        ValidateManifestRejectsDeviceNames();
        ValidateManifestRejectsMalformedHashes();
        ValidatePackageHashesRegularFiles();
        ValidatePackageAllowsEmptyRegularFile();
        ValidatePackageRejectsDirectory();
        ValidatePackageStreamsLargeFile();
        ValidatePackageAllowsUnicodeBaseDirectory();
        ValidatePackageRejectsWindowsDirectoryLinkEscape();
        CliUsesStrictOutputAndSafeErrors();
    }

    private static void ValidateManifestAcceptsContractValues()
    {
        ManifestValidator.Validate(ValidManifest());
        ManifestValidator.Validate(ValidManifest() with { Sha256 = new string('A', 64) });

        foreach (string archive in new[]
        {
            @"packages\runtime.pkg",
            "packages/runtime package_1-2.pkg",
            "console.pkg",
            "com0.pkg",
            "com10.pkg",
            "lpt0",
            "lpt10",
            "auxiliary",
        })
        {
            ManifestValidator.Validate(ValidManifest() with { Archive = archive });
        }
    }

    private static void ValidateManifestRejectsInvalidRuntimeIds()
    {
        foreach (string runtimeId in new[]
        {
            "", " openclaw", "openclaw/win", "openclaw:win", "openclaw win", "运行时",
        })
        {
            Throws<ManifestValidationException>(() =>
                ManifestValidator.Validate(ValidManifest() with { RuntimeId = runtimeId }));
        }
    }

    private static void ValidateManifestRejectsUnsafeArchives()
    {
        var archives = new List<string>
        {
            "", "/runtime.pkg", @"\runtime.pkg", @"C:\runtime.pkg", "C:runtime.pkg",
            @"\\server\share\runtime.pkg", @"\\?\C:\runtime.pkg", @"\\.\C:\runtime.pkg",
            "../runtime.pkg", @"..\runtime.pkg", "packages/../runtime.pkg",
            @"packages\..\runtime.pkg", @"packages/\runtime.pkg", "runtime.pkg:payload",
            "runtime.pkg\0payload", "runtime.pkg.", "runtime.pkg ", "运行时.pkg",
        };
        archives.AddRange(new[] { "<", ">", "\"", "|", "?", "*" }
            .Select(character => $"packages/runtime{character}.pkg"));
        archives.AddRange(Enumerable.Range(0, 32)
            .Select(value => $"packages/runtime{(char)value}.pkg"));
        archives.Add("packages/runtime\u007f.pkg");

        foreach (string archive in archives)
        {
            Throws<ManifestValidationException>(() =>
                ManifestValidator.Validate(ValidManifest() with { Archive = archive }));
        }
    }

    private static void ValidateManifestRejectsDeviceNames()
    {
        foreach (string archive in new[]
        {
            "CON", "con.txt", "packages/NuL.pkg", "aux", "PrN.log", "COM1", "com9.bin",
            "LPT1", "lPt9.archive.tar", "packages/CON .txt", "packages/NUL.txt. ",
            "COM¹", "com².txt", "packages/Com³.pkg", "LPT¹", "lpt².txt", "packages/LpT³.pkg",
            "CONIN$", "conin$.txt", "CONOUT$", "packages/conout$.pkg",
        })
        {
            Throws<ManifestValidationException>(() =>
                ManifestValidator.Validate(ValidManifest() with { Archive = archive }));
        }
    }

    private static void ValidateManifestRejectsMalformedHashes()
    {
        foreach (string hash in new[]
        {
            "", "abc", new string('a', 63), new string('a', 65), new string('g', 64),
        })
        {
            Throws<ManifestValidationException>(() =>
                ManifestValidator.Validate(ValidManifest() with { Sha256 = hash }));
        }
    }

    private static void ValidatePackageHashesRegularFiles()
    {
        using var directory = new TemporaryDirectory();
        Directory.CreateDirectory(Path.Combine(directory.Path, "packages"));
        byte[] payload = Encoding.UTF8.GetBytes("payload");
        File.WriteAllBytes(Path.Combine(directory.Path, "packages", "runtime.pkg"), payload);

        var manifest = ValidManifest() with { Sha256 = Convert.ToHexString(SHA256.HashData(payload)) };
        ManifestValidator.ValidatePackage(directory.Path, manifest);
        Throws<PackageValidationException>(() =>
            ManifestValidator.ValidatePackage(directory.Path, manifest with { Sha256 = new string('0', 64) }));
    }

    private static void ValidatePackageAllowsEmptyRegularFile()
    {
        using var directory = new TemporaryDirectory();
        File.WriteAllBytes(Path.Combine(directory.Path, "runtime.pkg"), Array.Empty<byte>());
        ManifestValidator.ValidatePackage(directory.Path, new Manifest(
            "openclaw-win-x64", "runtime.pkg", Convert.ToHexString(SHA256.HashData(Array.Empty<byte>()))));
    }

    private static void ValidatePackageRejectsDirectory()
    {
        using var directory = new TemporaryDirectory();
        Directory.CreateDirectory(Path.Combine(directory.Path, "runtime.pkg"));
        Throws<PackageValidationException>(() => ManifestValidator.ValidatePackage(
            directory.Path,
            new Manifest("openclaw-win-x64", "runtime.pkg", Convert.ToHexString(SHA256.HashData(Array.Empty<byte>())))));
    }

    private static void ValidatePackageStreamsLargeFile()
    {
        using var directory = new TemporaryDirectory();
        string archivePath = Path.Combine(directory.Path, "runtime.pkg");
        byte[] block = new byte[64 * 1024];
        using (var stream = File.Create(archivePath))
        {
            for (int index = 0; index < 64; index++)
            {
                stream.Write(block);
            }
        }

        using FileStream archive = File.OpenRead(archivePath);
        string hash = Convert.ToHexString(SHA256.HashData(archive));
        ManifestValidator.ValidatePackage(
            directory.Path,
            new Manifest("openclaw-win-x64", "runtime.pkg", hash));
    }

    private static void ValidatePackageAllowsUnicodeBaseDirectory()
    {
        using var parent = new TemporaryDirectory();
        string baseDirectory = Path.Combine(parent.Path, "中文 路径");
        Directory.CreateDirectory(baseDirectory);
        byte[] payload = Encoding.UTF8.GetBytes("unicode base directory");
        File.WriteAllBytes(Path.Combine(baseDirectory, "runtime.pkg"), payload);
        ManifestValidator.ValidatePackage(baseDirectory, new Manifest(
            "openclaw-win-x64", "runtime.pkg", Convert.ToHexString(SHA256.HashData(payload))));
    }

    private static void ValidatePackageRejectsWindowsDirectoryLinkEscape()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var baseDirectory = new TemporaryDirectory();
        using var outsideDirectory = new TemporaryDirectory();
        byte[] payload = Encoding.UTF8.GetBytes("outside Windows payload");
        File.WriteAllBytes(Path.Combine(outsideDirectory.Path, "runtime.pkg"), payload);
        string linkPath = Path.Combine(baseDirectory.Path, "packages");

        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = "cmd.exe",
            ArgumentList = { "/c", "mklink", "/J", linkPath, outsideDirectory.Path },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        if (process is null)
        {
            return;
        }

        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            return;
        }

        try
        {
            Throws<PackageValidationException>(() => ManifestValidator.ValidatePackage(
                baseDirectory.Path,
                ValidManifest() with { Sha256 = Convert.ToHexString(SHA256.HashData(payload)) }));
        }
        finally
        {
            Directory.Delete(linkPath);
        }
    }

    private static void CliUsesStrictOutputAndSafeErrors()
    {
        using var directory = new TemporaryDirectory("中文 路径");
        byte[] payload = Encoding.UTF8.GetBytes("cli payload");
        File.WriteAllBytes(Path.Combine(directory.Path, "runtime.pkg"), payload);
        string manifestPath = Path.Combine(directory.Path, "manifest.json");
        WriteManifest(manifestPath, "openclaw-win-x64", "runtime.pkg", Convert.ToHexString(SHA256.HashData(payload)));

        AssertRun(new[] { "--manifest", manifestPath }, 0,
            "{\"status\":\"ready\",\"candidate\":\"dotnet\"}" + Environment.NewLine, "");
        AssertRun(Array.Empty<string>(), 1, "", "E_ARGUMENTS" + Environment.NewLine);
        AssertRun(new[] { "--manifest" }, 1, "", "E_ARGUMENTS" + Environment.NewLine);

        string secretPath = Path.Combine(directory.Path, "private-secret-manifest.json");
        AssertRun(new[] { "--manifest", secretPath }, 1, "", "E_MANIFEST_READ" + Environment.NewLine);

        File.WriteAllText(manifestPath, "{\"runtimeId\":\"private-secret", Encoding.UTF8);
        AssertRun(new[] { "--manifest", manifestPath }, 1, "", "E_MANIFEST_JSON" + Environment.NewLine);

        File.WriteAllText(manifestPath,
            "{\"runtimeId\":\"openclaw-win-x64\",\"archive\":\"runtime.pkg\",\"sha256\":\"" +
            new string('0', 64) + "\",\"unknown\":true}", Encoding.UTF8);
        AssertRun(new[] { "--manifest", manifestPath }, 1, "", "E_MANIFEST_JSON" + Environment.NewLine);

        File.WriteAllText(manifestPath,
            "{\"runtimeId\":\"openclaw-win-x64\",\"archive\":\"runtime.pkg\",\"sha256\":\"" +
            new string('0', 64) + "\"} {}", Encoding.UTF8);
        AssertRun(new[] { "--manifest", manifestPath }, 1, "", "E_MANIFEST_JSON" + Environment.NewLine);

        WriteManifest(manifestPath, "private-secret", "runtime.pkg", new string('0', 64));
        AssertRun(new[] { "--manifest", manifestPath }, 1, "", "E_PACKAGE_INVALID" + Environment.NewLine);

        WriteManifest(manifestPath, "bad/id", "runtime.pkg", new string('0', 64));
        AssertRun(new[] { "--manifest", manifestPath }, 1, "", "E_MANIFEST_INVALID" + Environment.NewLine);
    }

    private static Manifest ValidManifest() => new(
        "openclaw-2026.7.1-2-win-x64", @"packages\runtime.pkg", new string('a', 64));

    private static void WriteManifest(string path, string runtimeId, string archive, string sha256)
    {
        string json = "{\"runtimeId\":\"" + runtimeId + "\",\"archive\":\"" +
            archive.Replace("\\", "\\\\", StringComparison.Ordinal) + "\",\"sha256\":\"" + sha256 + "\"}";
        File.WriteAllText(path, json, Encoding.UTF8);
    }

    private static void AssertRun(string[] args, int expectedExitCode, string expectedStdout, string expectedStderr)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        int exitCode = Program.Run(args, stdout, stderr);
        Equal(expectedExitCode, exitCode);
        Equal(expectedStdout, stdout.ToString());
        Equal(expectedStderr, stderr.ToString());
    }

    private static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"expected {expected}, got {actual}");
        }
    }

    private static void Throws<TException>(Action action)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }

        throw new InvalidOperationException($"expected {typeof(TException).Name}");
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory(string? childName = null)
        {
            _root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "u-claw-dotnet-" + Guid.NewGuid().ToString("N"));
            Path = childName is null ? _root : System.IO.Path.Combine(_root, childName);
            Directory.CreateDirectory(Path);
        }

        private readonly string _root;

        public string Path { get; }

        public void Dispose()
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
