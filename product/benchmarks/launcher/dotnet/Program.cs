using System.Text.Json;
using System.Text.Json.Serialization;

internal static class Program
{
    private const string ReadyJson = "{\"status\":\"ready\",\"candidate\":\"dotnet\"}";

    public static int Main(string[] args) => Run(args, Console.Out, Console.Error);

    internal static int Run(string[] args, TextWriter stdout, TextWriter stderr)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            try
            {
                ManifestValidatorTests.RunAll();
                stdout.WriteLine(ReadyJson);
                return 0;
            }
            catch
            {
                return Fail(stderr, "E_SELF_TEST");
            }
        }

        if (args.Length != 2 || args[0] != "--manifest" || args[1].Length == 0)
        {
            return Fail(stderr, "E_ARGUMENTS");
        }

        Manifest manifest;
        try
        {
            using FileStream stream = File.OpenRead(args[1]);
            manifest = JsonSerializer.Deserialize(stream, LauncherJsonContext.Default.Manifest)
                ?? throw new JsonException();
        }
        catch (JsonException)
        {
            return Fail(stderr, "E_MANIFEST_JSON");
        }
        catch
        {
            return Fail(stderr, "E_MANIFEST_READ");
        }

        try
        {
            ManifestValidator.Validate(manifest);
        }
        catch
        {
            return Fail(stderr, "E_MANIFEST_INVALID");
        }

        try
        {
            string baseDirectory = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
            ManifestValidator.ValidatePackage(baseDirectory, manifest);
        }
        catch
        {
            return Fail(stderr, "E_PACKAGE_INVALID");
        }

        stdout.WriteLine(ReadyJson);
        return 0;
    }

    private static int Fail(TextWriter stderr, string code)
    {
        stderr.WriteLine(code);
        return 1;
    }
}

[JsonSourceGenerationOptions(
    PropertyNameCaseInsensitive = false,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(Manifest))]
internal sealed partial class LauncherJsonContext : JsonSerializerContext
{
}
