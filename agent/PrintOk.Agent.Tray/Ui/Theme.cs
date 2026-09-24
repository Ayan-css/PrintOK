using System.Drawing.Drawing2D;

namespace PrintOk.Agent.Tray.Ui;

/// <summary>
/// The desktop agent's palette and widget defaults, taken from the website's
/// styles.css so the window on the counter PC and the dashboard on the other
/// screen are recognisably one product.
///
/// WinForms defaults to Windows 95 grey with a 3D border on everything. Nothing
/// here is decoration for its own sake — it is the minimum needed to stop the
/// agent looking like a utility someone found on a shareware CD, because a shop
/// owner is being asked to trust it with their printer and their customers'
/// documents.
/// </summary>
public static class Theme
{
    // Verbatim from styles.css.
    public static readonly Color Primary    = Color.FromArgb(0x0e, 0x5e, 0x6f); // --color-primary
    public static readonly Color Secondary  = Color.FromArgb(0xf5, 0xc4, 0x00); // --color-secondary
    public static readonly Color Success    = Color.FromArgb(0x1d, 0xb8, 0x7a); // --color-success
    public static readonly Color Danger     = Color.FromArgb(0xe0, 0x20, 0x20); // --color-danger
    public static readonly Color Warning    = Color.FromArgb(0xf5, 0xa6, 0x23); // --color-warning

    public static readonly Color Ink        = Color.FromArgb(0x0d, 0x0d, 0x0d);
    public static readonly Color Paper      = Color.FromArgb(0xff, 0xff, 0xff);
    public static readonly Color Surface    = Color.FromArgb(0xfa, 0xfa, 0xf7);
    public static readonly Color Line       = Color.FromArgb(0xe4, 0xe4, 0xdd);
    public static readonly Color TextMuted  = Color.FromArgb(0x88, 0x88, 0x80);

    public static readonly Font H1     = new("Segoe UI Semibold", 15f);
    public static readonly Font H2     = new("Segoe UI Semibold", 10.5f);
    public static readonly Font Body   = new("Segoe UI", 9.75f);
    public static readonly Font Label  = new("Segoe UI", 8.5f);
    public static readonly Font Mono   = new("Consolas", 9f);

    /// <summary>A flat, branded button. WinForms buttons are 3D grey otherwise.</summary>
    public static Button MakeButton(string text, bool primary = false)
    {
        var b = new Button
        {
            Text = text,
            AutoSize = false,
            Height = 32,
            FlatStyle = FlatStyle.Flat,
            Font = Theme.Body,
            Cursor = Cursors.Hand,
            BackColor = primary ? Primary : Paper,
            ForeColor = primary ? Color.White : Ink,
            Padding = new Padding(10, 0, 10, 0),
        };
        b.FlatAppearance.BorderColor = primary ? Primary : Line;
        b.FlatAppearance.BorderSize = 1;
        b.FlatAppearance.MouseOverBackColor = primary
            ? ControlPaint.Light(Primary, 0.1f)
            : Surface;
        return b;
    }

    /// <summary>
    /// A coloured state pill, matching the dashboard's job badges.
    ///
    /// Drawn rather than using a Label with a BackColor, because a square block
    /// of colour reads as an error box; the rounded capsule reads as a status.
    /// </summary>
    public sealed class Pill : Control
    {
        private Color _accent = TextMuted;

        public Color Accent
        {
            get => _accent;
            set { _accent = value; Invalidate(); }
        }

        public Pill()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                     | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            Font = Theme.Label;
            Height = 22;
            AutoSize = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            int radius = Height;

            using var path = new GraphicsPath();
            path.AddArc(r.X, r.Y, radius, radius, 90, 180);
            path.AddArc(r.Right - radius, r.Y, radius, radius, 270, 180);
            path.CloseFigure();

            // A tint of the accent rather than the accent itself: full-strength
            // green behind white text is louder than a status line should be.
            using var fill = new SolidBrush(Color.FromArgb(28, _accent));
            g.FillPath(fill, path);
            using var pen = new Pen(Color.FromArgb(90, _accent));
            g.DrawPath(pen, path);

            TextRenderer.DrawText(g, Text, Font, r, _accent,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }

    /// <summary>A label/value row, mirroring the dashboard's meta rows.</summary>
    public static TableLayoutPanel FieldGrid()
    {
        var t = new TableLayoutPanel
        {
            ColumnCount = 2,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Dock = DockStyle.Top,
            BackColor = Color.Transparent,
        };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return t;
    }

    public static void AddField(TableLayoutPanel grid, string label, Control value)
    {
        var l = new Label
        {
            Text = label,
            Font = Label,
            ForeColor = TextMuted,
            AutoSize = true,
            Margin = new Padding(0, 6, 8, 6),
        };
        grid.Controls.Add(l);
        value.Margin = new Padding(0, 5, 0, 5);
        grid.Controls.Add(value);
    }

    public static Label ValueLabel(string text = "—") => new()
    {
        Text = text,
        Font = Body,
        ForeColor = Ink,
        AutoSize = true,
    };
}
