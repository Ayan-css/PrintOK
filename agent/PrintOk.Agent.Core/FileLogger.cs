using System.Text;
using Microsoft.Extensions.Logging;

namespace PrintOk.WindowsPrintAgent.Services;

/// <summary>
/// Minimal rolling file logger.
///
/// A shop PC agent usually runs as a console window that someone may close, and
/// a crash takes its output with it. Writing to a file as well means a shop
/// owner can be asked for one file when something goes wrong, instead of being
/// asked to reproduce the problem with the window open.
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _path;
    private readonly object _gate = new();

    public FileLoggerProvider(string path)
    {
        _path = path;

        string? dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        // Keep one previous run for comparison, and stop the file growing forever.
        try
        {
            var info = new FileInfo(path);
            if (info.Exists && info.Length > 2 * 1024 * 1024)
            {
                File.Copy(path, path + ".1", overwrite: true);
                File.Delete(path);
            }
        }
        catch
        {
            // Logging must never prevent the agent from starting.
        }
    }

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);

    internal void Write(string line)
    {
        lock (_gate)
        {
            try
            {
                File.AppendAllText(_path, line + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
                // A locked or unwritable log file must not take the agent down.
            }
        }
    }

    public void Dispose() { }

    private sealed class FileLogger : ILogger
    {
        private readonly FileLoggerProvider _provider;
        private readonly string _category;

        public FileLogger(FileLoggerProvider provider, string category)
        {
            _provider = provider;
            _category = category;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;

            string message = formatter(state, exception);
            var line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} [{logLevel}] {_category}: {message}";
            if (exception is not null)
            {
                line += Environment.NewLine + exception;
            }

            _provider.Write(line);
        }
    }
}
