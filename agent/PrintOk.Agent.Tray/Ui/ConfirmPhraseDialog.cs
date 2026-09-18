namespace PrintOk.Agent.Tray.Ui;

/// <summary>
/// A confirmation that has to be typed, not clicked.
///
/// Used for the few actions on this window that stop a shop printing. A Yes/No
/// is one mis-click away on a counter PC anyone can reach, and the cost of that
/// mis-click is a shop that cannot print until somebody finds the dashboard and
/// pairs it again — in the middle of trading, with customers waiting.
///
/// It is not authentication and is not offered as any. It stops an accident and
/// a casual poke. Someone determined, with the machine unlocked, can still get
/// through it; an OS credential prompt is the answer to that and this is not a
/// substitute for one.
/// </summary>
internal sealed class ConfirmPhraseDialog : Form
{
    private readonly string _phrase;
    private readonly TextBox _entry;
    private readonly Button _confirm;

    public ConfirmPhraseDialog(string title, string explanation, string phrase)
    {
        _phrase = phrase;

        Text = title;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ClientSize = new Size(430, 190);

        var message = new Label
        {
            Text = explanation,
            Location = new Point(16, 16),
            Size = new Size(398, 70),
        };

        _entry = new TextBox
        {
            Location = new Point(16, 96),
            Size = new Size(398, 24),
            CharacterCasing = CharacterCasing.Upper,
        };

        _confirm = new Button
        {
            Text = "Confirm",
            DialogResult = DialogResult.OK,
            Location = new Point(238, 136),
            Size = new Size(84, 30),
            // Off until the phrase matches, so the button itself is the
            // feedback rather than an error after the fact.
            Enabled = false,
        };

        var cancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(330, 136),
            Size = new Size(84, 30),
        };

        _entry.TextChanged += (_, _) =>
            _confirm.Enabled = string.Equals(_entry.Text.Trim(), _phrase, StringComparison.Ordinal);

        Controls.AddRange(new Control[] { message, _entry, _confirm, cancel });
        AcceptButton = _confirm;
        CancelButton = cancel;
    }
}
