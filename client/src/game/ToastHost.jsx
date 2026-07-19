// Fixed-corner transient notifications, replacing the old blocking alert() calls.
function ToastHost({ toasts }) {
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>{t.text}</div>
      ))}
    </div>
  )
}

export default ToastHost
