namespace PrintOk.WindowsPrintAgent.Models;

/// <summary>How the agent is currently getting on with the platform.</summary>
public enum ConnectionState
{
    Starting,
    /// <summary>Polling and heartbeating normally.</summary>
    Connected,
    /// <summary>Reachable, but the live push channel is down; polling still works.</summary>
    Degraded,
    /// <summary>The API cannot be reached at all. Nothing will print.</summary>
    Offline,
    /// <summary>No credential. The shop owner needs to pair this PC.</summary>
    NotPaired,
}

/// <summary>
/// A live, shared snapshot of what the worker is doing.
///
/// The desktop agent needs to show connection state, the last error, and a
/// running count of jobs — and the console host needs none of it. Rather than
/// give the worker a reference to a window it must not know about, the worker
/// writes here and any host reads.
///
/// Every member is safe to touch from any thread: the worker updates from its
/// polling loop while the UI thread paints from a timer.
/// </summary>
public sealed class AgentStatus
{
    private readonly object _gate = new();

    private ConnectionState _state = ConnectionState.Starting;
    private string? _lastError;
    private DateTimeOffset? _lastHeartbeat;
    private DateTimeOffset? _lastJobAt;
    private int _jobsPrinted;
    private int _jobsFailed;
    private bool _pushConnected;

    /// <summary>Raised whenever anything below changes, so the UI can repaint.</summary>
    public event Action? Changed;

    public ConnectionState State { get { lock (_gate) return _state; } }
    public string? LastError { get { lock (_gate) return _lastError; } }
    public DateTimeOffset? LastHeartbeat { get { lock (_gate) return _lastHeartbeat; } }
    public DateTimeOffset? LastJobAt { get { lock (_gate) return _lastJobAt; } }
    public int JobsPrinted { get { lock (_gate) return _jobsPrinted; } }
    public int JobsFailed { get { lock (_gate) return _jobsFailed; } }
    public bool PushConnected { get { lock (_gate) return _pushConnected; } }

    /// <summary>Identity, filled in once at startup.</summary>
    public string? PrinterId { get; set; }
    public string? ShopId { get; set; }
    public string? DeviceId { get; set; }
    public string? ApiBaseUrl { get; set; }
    public DateTimeOffset? TokenExpiresAt { get; set; }
    public string? AuthMethod { get; set; }

    public void SetState(ConnectionState state, string? error = null)
    {
        lock (_gate)
        {
            if (_state == state && _lastError == error) return;
            _state = state;
            // A successful state clears the previous failure, so the window does
            // not keep showing an error that has since been resolved.
            _lastError = state is ConnectionState.Connected or ConnectionState.Degraded ? null : error;
        }
        Changed?.Invoke();
    }

    public void RecordHeartbeat()
    {
        lock (_gate) _lastHeartbeat = DateTimeOffset.Now;
        Changed?.Invoke();
    }

    public void RecordPush(bool connected)
    {
        lock (_gate) _pushConnected = connected;
        Changed?.Invoke();
    }

    public void RecordJob(bool printed)
    {
        lock (_gate)
        {
            if (printed) _jobsPrinted++; else _jobsFailed++;
            _lastJobAt = DateTimeOffset.Now;
        }
        Changed?.Invoke();
    }
}
