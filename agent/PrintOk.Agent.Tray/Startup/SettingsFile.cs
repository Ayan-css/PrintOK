using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrintOk.Agent.Tray.Startup;

/// <summary>
/// Reads and writes the appsettings.json beside the executable.
///
/// The settings tab has to persist somewhere the agent will read on its next
/// start, and that file already is the agent's configuration — adding a second
/// store would mean two sources of truth and a support conversation about which
/// one won.
///
/// Edits are surgical: the file is parsed as a JSON node tree and only the
/// touched keys are replaced, so the explanatory "_comment" entries and any
/// hand-written Logging section survive a save from the UI.
///
/// The device token is never written here. It stays in the DPAPI-encrypted
/// credential store, so this file remains safe to screenshot for support.
/// </summary>
public sealed class SettingsFile
{
    private readonly string _path;

    public SettingsFile(string? directory = null)
    {
        directory ??= AppContext.BaseDirectory;
        _path = System.IO.Path.Combine(directory, "appsettings.json");
    }

    public string Path => _path;
    public bool Exists => File.Exists(_path);

    public string? Read(string key)
    {
        try
        {
            if (!File.Exists(_path)) return null;
            var root = JsonNode.Parse(File.ReadAllText(_path)) as JsonObject;
            return root?[key]?.GetValue<string>();
        }
        catch
        {
            return null;
        }
    }

    public int? ReadInt(string key)
    {
        try
        {
            if (!File.Exists(_path)) return null;
            var root = JsonNode.Parse(File.ReadAllText(_path)) as JsonObject;
            var node = root?[key];
            return node is null ? null : node.GetValue<int>();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Applies a set of changes and returns whether the file was written.
    ///
    /// A null value removes the key, which is how "use the built-in default"
    /// is expressed — clearing the API URL must fall back to the compiled-in
    /// production address rather than writing an empty string the agent would
    /// then try to dial.
    /// </summary>
    public bool Write(IDictionary<string, object?> changes)
    {
        try
        {
            JsonObject root;
            if (File.Exists(_path))
            {
                root = JsonNode.Parse(File.ReadAllText(_path)) as JsonObject ?? new JsonObject();
            }
            else
            {
                root = new JsonObject();
            }

            foreach (var (key, value) in changes)
            {
                if (value is null)
                {
                    root.Remove(key);
                    continue;
                }

                root[key] = value switch
                {
                    int i => JsonValue.Create(i),
                    bool b => JsonValue.Create(b),
                    _ => JsonValue.Create(value.ToString() ?? ""),
                };
            }

            // Written to a sibling then moved, so a crash mid-write cannot
            // leave the agent with a half-written config it will not parse.
            string temp = _path + ".tmp";
            File.WriteAllText(temp, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temp, _path, overwrite: true);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
