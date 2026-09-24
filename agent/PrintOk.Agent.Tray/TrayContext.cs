using System.Drawing.Drawing2D;
using PrintOk.Agent.Tray.Ui;
using PrintOk.WindowsPrintAgent.Models;

namespace PrintOk.Agent.Tray;

/// <summary>
/// The agent's actual lifetime.
///
/// The application runs on this context rather than on a form, which is what
/// lets the window be closed without the process ending — closing a form that
/// Application.Run owns would stop the message loop and take the shop offline.
///
/// The tray icon is therefore the agent, and the window is a view of it.
/// </summary>
public sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon _icon;
    private readonly AgentStatus _status;
    private readonly Func<MainForm> _windowFactory;
    private readonly Action _quit;
    private readonly System.Windows.Forms.Timer _poll = new() { Interval = 2000 };

    private MainForm? _window;
    private ConnectionState _lastNotified = ConnectionState.Starting;

    public TrayContext(AgentStatus status, Func<MainForm> windowFactory, Action quit)
    {
        _status = status;
        _windowFactory = windowFactory;
        _quit = quit;

        var menu = new ContextMenuStrip { Font = Theme.Body };
        menu.Items.Add("Open PrintOk", null, (_, _) => ShowWindow());
        menu.Items.Add("Pair this PC…", null, (_, _) => ShowWindow(tab: 2));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, _) => Quit());

        _icon = new NotifyIcon
        {
            Icon = BuildIcon(Theme.TextMuted),
            Text = "PrintOk — starting",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _icon.DoubleClick += (_, _) => ShowWindow();

        _poll.Tick += (_, _) => Sync();
        _poll.Start();
        Sync();
    }

    /// <summary>Opens the window from outside, e.g. a first run with no credential.</summary>
    public void OpenWindow() => ShowWindow();

    private void ShowWindow(int tab = 0)
    {
        if (_window is null || _window.IsDisposed)
        {
            _window = _windowFactory();
        }

        _window.Show();
        if (_window.WindowState == FormWindowState.Minimized)
        {
            _window.WindowState = FormWindowState.Normal;
        }
        _window.Activate();
        _window.BringToFront();

        if (tab > 0 && _window.Controls.OfType<TabControl>().FirstOrDefault() is { } tabs
            && tab < tabs.TabPages.Count)
        {
            tabs.SelectedIndex = tab;
        }
    }

    private void Quit()
    {
        var answer = MessageBox.Show(
            "Quitting stops this PC printing customer jobs until the agent is started again.\n\nQuit PrintOk?",
            "PrintOk", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);

        if (answer != DialogResult.Yes) return;

        _icon.Visible = false;
        if (_window is { IsDisposed: false })
        {
            _window.AllowClose = true;
            _window.Close();
        }

        _quit();
        ExitThread();
    }

    /// <summary>Keeps the icon, tooltip and balloon warnings in step with the worker.</summary>
    private void Sync()
    {
        var state = _status.State;

        var (colour, label) = state switch
        {
            ConnectionState.Connected => (Theme.Success, "Connected — ready to print"),
            ConnectionState.Degraded  => (Theme.Warning, "Connected — live updates down"),
            ConnectionState.Offline   => (Theme.Danger, "Offline — cannot reach PrintOk"),
            ConnectionState.NotPaired => (Theme.Warning, "Not paired — open PrintOk to pair"),
            _                         => (Theme.TextMuted, "Starting…"),
        };

        _icon.Icon?.Dispose();
        _icon.Icon = BuildIcon(colour);
        // NotifyIcon truncates past 63 characters and simply drops longer text
        // on some Windows builds, taking the whole tooltip with it.
        string text = $"PrintOk — {label}";
        _icon.Text = text.Length > 62 ? text[..62] : text;

        // Tell the shop once, when it breaks. A balloon every two seconds would
        // be worse than silence.
        if (state != _lastNotified)
        {
            if (state == ConnectionState.Offline)
            {
                _icon.ShowBalloonTip(8000, "PrintOk is offline",
                    "This PC cannot reach PrintOk, so customer jobs will not print.", ToolTipIcon.Warning);
            }
            else if (state == ConnectionState.NotPaired)
            {
                _icon.ShowBalloonTip(8000, "PrintOk needs pairing",
                    "Open PrintOk from this icon and pair this PC to start printing.", ToolTipIcon.Warning);
            }
            else if (state == ConnectionState.Connected && _lastNotified is ConnectionState.Offline or ConnectionState.NotPaired)
            {
                _icon.ShowBalloonTip(4000, "PrintOk is connected", "Customer jobs will print again.", ToolTipIcon.Info);
            }

            _lastNotified = state;
        }

        AskAboutCashJob();
    }

    private readonly HashSet<string> _askedCash = new();
    private bool _asking;

    /// <summary>
    /// One prompt at a time, once per order, on top of whatever the counter PC
    /// is showing. "Later" leaves it for the dashboard.
    /// </summary>
    private async void AskAboutCashJob()
    {
        if (_asking || _status.DecideCashJob is null) return;
        var job = _status.CashJobs.FirstOrDefault(j => !_askedCash.Contains(j.Id));
        if (job is null) return;

        _asking = true;
        _askedCash.Add(job.Id);
        try
        {
            string who = string.IsNullOrWhiteSpace(job.CustomerName) ? "" : $" from {job.CustomerName}";
            using var owner = new Form { TopMost = true, ShowInTaskbar = false };
            var answer = MessageBox.Show(owner,
                $"Cash order {job.TokenNumber}{who}\n\n{job.FileName}\n" +
                $"{job.PageCount} page(s) × {job.Copies} — ₹{job.TotalPriceInCents / 100m:0.00}\n\n" +
                "Yes — cash received, print it\nNo — reject this order\nCancel — decide later in the dashboard",
                "PrintOk — cash payment", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button3);

            if (answer == DialogResult.Cancel) return;
            bool approve = answer == DialogResult.Yes;
            bool ok = await _status.DecideCashJob(job.Id, approve);
            _icon.ShowBalloonTip(4000, "PrintOk",
                ok ? (approve ? $"Order {job.TokenNumber} is printing." : $"Order {job.TokenNumber} was rejected.")
                   : $"Order {job.TokenNumber} could not be updated — use the dashboard.",
                ok ? ToolTipIcon.Info : ToolTipIcon.Warning);
        }
        finally
        {
            _asking = false;
        }
    }

    /// <summary>
    /// The tray icon, drawn rather than shipped as a .ico.
    ///
    /// It has to change colour with connection state, which a static resource
    /// cannot do, and drawing it keeps the brand mark consistent with the
    /// console banner and the dashboard without carrying five icon files.
    /// </summary>
    private static Icon BuildIcon(Color accent)
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            // The brand mark, from the icon compiled into this .exe (brand/),
            // so the tray and the file on disk are the same picture.
            using (var mark = Environment.ProcessPath is { } exe ? Icon.ExtractAssociatedIcon(exe) : null)
            {
                if (mark is not null) g.DrawIcon(mark, new Rectangle(0, 0, 32, 32));
                else { using var ink = new SolidBrush(Theme.Primary); g.FillRectangle(ink, 0, 0, 32, 32); }
            }

            // Status dot, bottom-right, which is the part that actually changes.
            using var dot = new SolidBrush(accent);
            g.FillEllipse(dot, 18, 18, 12, 12);
            using var ring = new Pen(Color.White, 2f);
            g.DrawEllipse(ring, 18, 18, 12, 12);
        }

        return Icon.FromHandle(bmp.GetHicon());
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _poll.Dispose();
            _icon.Visible = false;
            _icon.Dispose();
        }
        base.Dispose(disposing);
    }
}
