import React from 'react';
import { X } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({ isOpen, title, message, onConfirm, onCancel }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface border border-border w-full max-w-md rounded-lg shadow-xl shrink-0">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onCancel} className="text-text-secondary hover:text-text-primary">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 text-text-secondary whitespace-pre-wrap">
          {message}
        </div>
        <div className="flex items-center justify-end gap-3 p-4 border-t border-border bg-black/20">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded hover:bg-border/50 text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirm();
              onCancel();
            }}
            className="px-4 py-2 text-sm font-medium rounded bg-primary text-black hover:bg-primary/90"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};
