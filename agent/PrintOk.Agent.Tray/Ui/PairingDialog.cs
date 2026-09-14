namespace PrintOk.Agent.Tray.Ui;

/// <summary>
/// Asks for the pairing code, and says where it is about to send it.
///
/// The server address is shown rather than hidden because a wrong one is the
/// single most common pairing failure: the agent dials a machine that is not
/// there and the error looks like a rejected code. Putting the address in front
/// of the person typing the code makes that self-diagnosing.
/// </summary>
public sealed class PairingDialog : Form
{
    private readonly TextBox _code;

    public string Code => _code.Text.Trim();

    public PairingDialog(string apiBaseUrl)
    {
        Text = "Pair this PC";
        ClientSize = new Size(430, 250);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        BackColor = Theme.Surface;
        Font = Theme.Body;

        var heading = new Label
        {
            Text = "Enter the pairing code",
            Font = Theme.H2,
            ForeColor = Theme.Ink,
            AutoSize = true,
            Location = new Point(20, 20),
        };

        var help = new Label
        {
            Text = "Open your PrintOk dashboard, go to the QR Poster & Agent tab,\n"
                 + "and click Pair New Agent. The code is single use and expires\n"
                 + "after 15 minutes.",
            Font = Theme.Label,
            ForeColor = Theme.TextMuted,
            AutoSize = true,
            Location = new Point(20, 48),
        };

        _code = new TextBox
        {
            Location = new Point(20, 112),
            Width = 220,
            Font = new Font("Consolas", 14f),
            CharacterCasing = CharacterCasing.Upper,
            MaxLength = 9,
            PlaceholderText = "XXXX-XXXX",
        };

        var target = new Label
        {
            Text = $"Will pair with  {apiBaseUrl}",
            Font = Theme.Label,
            ForeColor = Theme.TextMuted,
            AutoSize = true,
            Location = new Point(20, 152),
        };

        var ok = Theme.MakeButton("Pair", primary: true);
        ok.Width = 110;
        ok.Location = new Point(300, 196);
        ok.DialogResult = DialogResult.OK;

        var cancel = Theme.MakeButton("Cancel");
        cancel.Width = 100;
        cancel.Location = new Point(190, 196);
        cancel.DialogResult = DialogResult.Cancel;

        Controls.AddRange(new Control[] { heading, help, _code, target, ok, cancel });

        AcceptButton = ok;
        CancelButton = cancel;
    }
}
