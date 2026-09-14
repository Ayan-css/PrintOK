using PrintOk.Agent.Tray.Startup;
using PrintOk.WindowsPrintAgent.Models;
using PrintOk.WindowsPrintAgent.Services;

namespace PrintOk.Agent.Tray.Ui;

/// <summary>
/// The window a shop owner opens from the tray.
///
/// Deliberately read-mostly. Five tabs answering the five questions that
/// actually get asked when a shop rings up: is it connected, can it see my
/// printer, which PC is this, what are the settings, and what went wrong.
///
/// Closing it hides it rather than exiting: the agent has to keep printing with
/// the window shut, and a shop owner clicking the X expects a window to go
/// away, not their shop to go offline. Quit is a deliberate act from the tray
/// menu.
/// </summary>
public sealed class MainForm : Form
{
    private readonly AgentStatus _status;
    private readonly AgentSettings _settings;
    private readonly CredentialStore _credentials;
    private readonly string _logPath;
    private readonly Func<string, CancellationToken, Task<bool>> _pair;

    private readonly System.Windows.Forms.Timer _refresh = new() { Interval = 1000 };

    private Theme.Pill _statePill = null!;
    private Label _stateDetail = null!;
    private Label _lastHeartbeat = null!;
    private Label _pushState = null!;
    private Label _jobsPrinted = null!;
    private Label _jobsFailed = null!;
    private ListView _printerList = null!;
    private TextBox _logBox = null!;
    private Label _deviceId = null!;
    private Label _printerId = null!;
    private Label _shopId = null!;
    private Label _apiUrl = null!;
    private Label _tokenExpiry = null!;
    private Label _authMethod = null!;
    private CheckBox _autoStart = null!;
    private Label _autoStartDetail = null!;
    private ComboBox _printerChoice = null!;
    private TextBox _apiUrlBox = null!;

    public MainForm(
        AgentStatus status,
        AgentSettings settings,
        CredentialStore credentials,
        string logPath,
        Func<string, CancellationToken, Task<bool>> pair)
    {
        _status = status;
        _settings = settings;
        _credentials = credentials;
        _logPath = logPath;
        _pair = pair;

        Text = "PrintOk Print Agent";
        ClientSize = new Size(720, 520);
        MinimumSize = new Size(640, 460);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Theme.Surface;
        Font = Theme.Body;

        BuildChrome();

        _refresh.Tick += (_, _) => Repaint();
        _refresh.Start();
        Repaint();
    }

    /// <summary>Set by the tray when the user really means to exit.</summary>
    public bool AllowClose { get; set; }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // A shop owner closing the window must not take the shop offline.
        if (!AllowClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    // ------------------------------------------------------------------ chrome ---

    private void BuildChrome()
    {
        var header = new Panel { Dock = DockStyle.Top, Height = 64, BackColor = Theme.Paper };
        var title = new Label
        {
            Text = "PrintOk",
            Font = Theme.H1,
            ForeColor = Theme.Ink,
            AutoSize = true,
            Location = new Point(20, 14),
        };
        var subtitle = new Label
        {
            Text = "Print agent",
            Font = Theme.Label,
            ForeColor = Theme.TextMuted,
            AutoSize = true,
            Location = new Point(22, 38),
        };

        _statePill = new Theme.Pill { Text = "Starting", Width = 130, Location = new Point(560, 22), Anchor = AnchorStyles.Top | AnchorStyles.Right };

        header.Controls.AddRange(new Control[] { title, subtitle, _statePill });

        var rule = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Theme.Line };

        var tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(14, 6) };
        tabs.TabPages.Add(BuildStatusTab());
        tabs.TabPages.Add(BuildPrintersTab());
        tabs.TabPages.Add(BuildDeviceTab());
        tabs.TabPages.Add(BuildSettingsTab());
        tabs.TabPages.Add(BuildLogsTab());

        Controls.Add(tabs);
        Controls.Add(rule);
        Controls.Add(header);
    }

    private static TabPage Page(string title) => new(title)
    {
        BackColor = Theme.Surface,
        Padding = new Padding(18),
    };

    // ------------------------------------------------------------------ status ---

    private TabPage BuildStatusTab()
    {
        var page = Page("Status");
        var grid = Theme.FieldGrid();

        _stateDetail  = Theme.ValueLabel();
        _lastHeartbeat = Theme.ValueLabel();
        _pushState    = Theme.ValueLabel();
        _jobsPrinted  = Theme.ValueLabel("0");
        _jobsFailed   = Theme.ValueLabel("0");

        Theme.AddField(grid, "Connection", _stateDetail);
        Theme.AddField(grid, "Last contact", _lastHeartbeat);
        Theme.AddField(grid, "Live updates", _pushState);
        Theme.AddField(grid, "Printed this session", _jobsPrinted);
        Theme.AddField(grid, "Failed this session", _jobsFailed);

        var note = new Label
        {
            Text = "This window can be closed. The agent keeps running in the background "
                 + "and stays in the system tray.",
            Font = Theme.Label,
            ForeColor = Theme.TextMuted,
            Dock = DockStyle.Bottom,
            Height = 34,
        };

        page.Controls.Add(grid);
        page.Controls.Add(note);
        return page;
    }

    // ---------------------------------------------------------------- printers ---

    private TabPage BuildPrintersTab()
    {
        var page = Page("Printers");

        _printerList = new ListView
        {
            Dock = DockStyle.Fill,
            View = View.Details,
            FullRowSelect = true,
            GridLines = false,
            BorderStyle = BorderStyle.FixedSingle,
            BackColor = Theme.Paper,
            Font = Theme.Body,
        };
        _printerList.Columns.Add("Printer", 300);
        _printerList.Columns.Add("Default", 80);
        _printerList.Columns.Add("Colour", 80);
        _printerList.Columns.Add("Duplex", 80);

        var refresh = Theme.MakeButton("Refresh list");
        refresh.Click += (_, _) => LoadPrinters();

        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44, FlowDirection = FlowDirection.LeftToRight };
        bar.Controls.Add(refresh);

        page.Controls.Add(_printerList);
        page.Controls.Add(bar);

        LoadPrinters();
        return page;
    }

    private void LoadPrinters()
    {
        _printerList.Items.Clear();
        try
        {
            foreach (var p in LocalPrinters.All())
            {
                var item = new ListViewItem(p.Name);
                item.SubItems.Add(p.IsDefault ? "Yes" : "");
                item.SubItems.Add(p.SupportsColour ? "Yes" : "No");
                item.SubItems.Add(p.SupportsDuplex ? "Yes" : "No");
                _printerList.Items.Add(item);
            }

            if (_printerList.Items.Count == 0)
            {
                _printerList.Items.Add(new ListViewItem("No printers installed on this PC"));
            }
        }
        catch (Exception ex)
        {
            _printerList.Items.Add(new ListViewItem($"Could not read printers: {ex.Message}"));
        }
    }

    // ------------------------------------------------------------------ device ---

    private TabPage BuildDeviceTab()
    {
        var page = Page("This PC");
        var grid = Theme.FieldGrid();

        _deviceId    = Theme.ValueLabel();
        _printerId   = Theme.ValueLabel();
        _shopId      = Theme.ValueLabel();
        _apiUrl      = Theme.ValueLabel();
        _tokenExpiry = Theme.ValueLabel();
        _authMethod  = Theme.ValueLabel();

        Theme.AddField(grid, "Device", _deviceId);
        Theme.AddField(grid, "Printer", _printerId);
        Theme.AddField(grid, "Shop", _shopId);
        Theme.AddField(grid, "Server", _apiUrl);
        Theme.AddField(grid, "Credential", _authMethod);
        Theme.AddField(grid, "Expires", _tokenExpiry);
        Theme.AddField(grid, "Agent version", Theme.ValueLabel(AgentVersion.Current));

        var pairBtn = Theme.MakeButton("Pair this PC…", primary: true);
        pairBtn.Width = 150;
        pairBtn.Click += (_, _) => ShowPairingDialog();

        var unpair = Theme.MakeButton("Forget credential");
        unpair.Width = 150;
        unpair.Click += (_, _) => ForgetCredential();

        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, FlowDirection = FlowDirection.LeftToRight };
        bar.Controls.Add(pairBtn);
        bar.Controls.Add(unpair);

        page.Controls.Add(grid);
        page.Controls.Add(bar);
        return page;
    }

    private void ForgetCredential()
    {
        var answer = MessageBox.Show(
            "This PC will stop printing until it is paired again with a new code from your dashboard.\n\nForget the stored credential?",
            "PrintOk", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);

        if (answer != DialogResult.Yes) return;

        _credentials.Delete();
        _status.SetState(ConnectionState.NotPaired, "This PC is no longer paired.");
        MessageBox.Show("Credential removed. Pair this PC again to resume printing.", "PrintOk");
    }

    /// <summary>
    /// Pairing, as a dialog rather than the console prompt it used to be.
    ///
    /// It reports which of the two failures happened, because "could not reach
    /// the server" and "the server rejected your code" need opposite actions and
    /// telling someone to fetch a fresh code when the request never left the PC
    /// sends them round a loop that cannot succeed.
    /// </summary>
    private async void ShowPairingDialog()
    {
        using var dialog = new PairingDialog(_settings.ApiBaseUrl);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        string code = dialog.Code;
        if (string.IsNullOrWhiteSpace(code)) return;

        Cursor = Cursors.WaitCursor;
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            bool ok = await _pair(code, cts.Token);

            if (ok)
            {
                MessageBox.Show(
                    "This PC is paired and will start printing.\n\nThe code is not needed again.",
                    "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                MessageBox.Show(
                    "Pairing did not complete.\n\nOpen the Logs tab for the reason — it says whether the "
                    + "server rejected the code, or could not be reached at all.",
                    "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        finally
        {
            Cursor = Cursors.Default;
        }
    }

    // ---------------------------------------------------------------- settings ---

    private TabPage BuildSettingsTab()
    {
        var page = Page("Settings");
        var grid = Theme.FieldGrid();

        _autoStart = new CheckBox
        {
            Text = "Start automatically when this PC starts",
            AutoSize = true,
            Font = Theme.Body,
            Checked = AutoStart.IsEnabled(),
        };
        _autoStart.CheckedChanged += (_, _) => ToggleAutoStart();

        _autoStartDetail = new Label
        {
            Font = Theme.Label,
            ForeColor = Theme.TextMuted,
            AutoSize = true,
        };

        _printerChoice = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            Width = 320,
            Font = Theme.Body,
        };
        _printerChoice.Items.Add("(this PC's default printer)");
        foreach (var p in LocalPrinters.All()) _printerChoice.Items.Add(p.Name);
        _printerChoice.SelectedIndex = 0;
        if (!string.IsNullOrWhiteSpace(_settings.PrinterName))
        {
            int idx = _printerChoice.Items.IndexOf(_settings.PrinterName);
            if (idx >= 0) _printerChoice.SelectedIndex = idx;
        }

        _apiUrlBox = new TextBox
        {
            Width = 320,
            Font = Theme.Body,
            Text = _settings.ApiBaseUrl,
        };

        Theme.AddField(grid, "Startup", _autoStart);
        Theme.AddField(grid, "", _autoStartDetail);
        Theme.AddField(grid, "Print to", _printerChoice);
        Theme.AddField(grid, "Server", _apiUrlBox);

        var save = Theme.MakeButton("Save settings", primary: true);
        save.Width = 140;
        save.Click += (_, _) => SaveSettings();

        var note = new Label
        {
            Text = "Changes to the printer or server take effect the next time the agent starts.",
            Font = Theme.Label,
            ForeColor = Theme.TextMuted,
            Dock = DockStyle.Bottom,
            Height = 30,
        };

        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44 };
        bar.Controls.Add(save);

        page.Controls.Add(grid);
        page.Controls.Add(bar);
        page.Controls.Add(note);

        UpdateAutoStartDetail();
        return page;
    }

    private void ToggleAutoStart()
    {
        if (_autoStart.Checked)
        {
            var method = AutoStart.Enable();
            if (method == AutoStart.Method.None)
            {
                MessageBox.Show(
                    "Windows would not accept the startup entry. You can add a shortcut to this "
                    + "program in your Startup folder instead (press Win+R and enter shell:startup).",
                    "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                _autoStart.Checked = false;
            }
        }
        else
        {
            AutoStart.Disable();
        }

        UpdateAutoStartDetail();
    }

    private void UpdateAutoStartDetail()
    {
        _autoStartDetail.Text = AutoStart.Current() switch
        {
            AutoStart.Method.ScheduledTask => "Starts at sign-in, and restarts itself if it stops.",
            AutoStart.Method.RunKey => "Starts at sign-in. Will not restart itself if it stops.",
            _ => "The agent will not start on its own after a restart.",
        };
    }

    private void SaveSettings()
    {
        var file = new SettingsFile();
        string chosen = _printerChoice.SelectedIndex <= 0 ? "" : _printerChoice.SelectedItem?.ToString() ?? "";
        string url = _apiUrlBox.Text.Trim();

        var changes = new Dictionary<string, object?>
        {
            ["PrinterName"] = chosen,
            // Empty means "use the built-in production address", which is the
            // right behaviour for a shop that has pasted something wrong in.
            ["PrintOkApiUrl"] = string.IsNullOrWhiteSpace(url) ? null : url,
        };

        if (file.Write(changes))
        {
            MessageBox.Show(
                $"Saved to:\n{file.Path}\n\nRestart the agent from the tray menu to apply them.",
                "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        else
        {
            MessageBox.Show(
                $"Could not write to:\n{file.Path}\n\nThe agent may be installed in a folder that needs "
                + "administrator rights. Move it somewhere under your own user folder.",
                "PrintOk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // -------------------------------------------------------------------- logs ---

    private TabPage BuildLogsTab()
    {
        var page = Page("Logs");

        _logBox = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Font = Theme.Mono,
            BackColor = Theme.Paper,
            BorderStyle = BorderStyle.FixedSingle,
        };

        var reload = Theme.MakeButton("Reload");
        reload.Click += (_, _) => LoadLog();

        var openFolder = Theme.MakeButton("Open log folder");
        openFolder.Width = 140;
        openFolder.Click += (_, _) => OpenLogFolder();

        var copy = Theme.MakeButton("Copy to clipboard");
        copy.Width = 150;
        copy.Click += (_, _) =>
        {
            if (!string.IsNullOrEmpty(_logBox.Text)) Clipboard.SetText(_logBox.Text);
        };

        var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44 };
        bar.Controls.AddRange(new Control[] { reload, openFolder, copy });

        page.Controls.Add(_logBox);
        page.Controls.Add(bar);

        LoadLog();
        return page;
    }

    private void LoadLog()
    {
        try
        {
            if (!File.Exists(_logPath))
            {
                _logBox.Text = "No log file yet.";
                return;
            }

            // Tail only. These files reach megabytes on a busy shop and nobody
            // scrolls to the top of one.
            using var stream = new FileStream(_logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            var lines = new Queue<string>();
            while (reader.ReadLine() is { } line)
            {
                lines.Enqueue(line);
                if (lines.Count > 500) lines.Dequeue();
            }

            _logBox.Text = string.Join(Environment.NewLine, lines);
            _logBox.SelectionStart = _logBox.TextLength;
            _logBox.ScrollToCaret();
        }
        catch (Exception ex)
        {
            _logBox.Text = $"Could not read the log: {ex.Message}";
        }
    }

    private void OpenLogFolder()
    {
        try
        {
            string? dir = System.IO.Path.GetDirectoryName(_logPath);
            if (dir is null) return;
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = dir,
                UseShellExecute = true,
            });
        }
        catch
        {
            MessageBox.Show($"The log is at:\n{_logPath}", "PrintOk");
        }
    }

    // ----------------------------------------------------------------- repaint ---

    private void Repaint()
    {
        var (text, colour, detail) = _status.State switch
        {
            ConnectionState.Connected  => ("Connected", Theme.Success, "Working normally."),
            ConnectionState.Degraded   => ("Limited", Theme.Warning, "Connected, but live updates are down. Jobs still arrive."),
            ConnectionState.Offline    => ("Offline", Theme.Danger, _status.LastError ?? "Cannot reach PrintOk."),
            ConnectionState.NotPaired  => ("Not paired", Theme.Warning, _status.LastError ?? "Pair this PC from the 'This PC' tab."),
            _                          => ("Starting", Theme.TextMuted, "Connecting…"),
        };

        _statePill.Text = text;
        _statePill.Accent = colour;
        _stateDetail.Text = detail;
        _stateDetail.ForeColor = _status.State == ConnectionState.Connected ? Theme.Ink : colour;

        _lastHeartbeat.Text = _status.LastHeartbeat is { } hb
            ? $"{(int)(DateTimeOffset.Now - hb).TotalSeconds}s ago"
            : "—";
        _pushState.Text = _status.PushConnected ? "Connected" : "Reconnecting…";
        _jobsPrinted.Text = _status.JobsPrinted.ToString();
        _jobsFailed.Text = _status.JobsFailed.ToString();

        _deviceId.Text  = _status.DeviceId ?? "—";
        _printerId.Text = _status.PrinterId ?? "—";
        _shopId.Text    = _status.ShopId ?? "—";
        _apiUrl.Text    = _status.ApiBaseUrl ?? _settings.ApiBaseUrl;
        _authMethod.Text = _status.AuthMethod ?? "—";
        _tokenExpiry.Text = _status.TokenExpiresAt?.ToLocalTime().ToString("d MMM yyyy") ?? "—";
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _refresh.Dispose();
        base.Dispose(disposing);
    }
}
