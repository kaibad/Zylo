import { FiAlertTriangle } from 'react-icons/fi';

function ConfirmModal({ title, message, onConfirm, onCancel }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-emoji" style={{ color: '#ef4444', marginBottom: '1rem' }}>
          <FiAlertTriangle size={48} />
        </div>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="modal-actions" style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'center' }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmModal;
