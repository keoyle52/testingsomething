import React from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { Button } from './Button';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-backdrop" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
      <div className="glass-card w-full max-w-md shadow-2xl animate-fade-in" style={{ border: '1px solid rgba(27,34,48,0.8)' }}>
        <div className="flex items-center gap-3 p-5 border-b border-border">
          <div className="w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center text-warning shrink-0">
            <AlertTriangle size={18} />
          </div>
          <h3 className="text-base font-semibold flex-1">{title}</h3>
          <button onClick={onCancel} className="text-text-muted hover:text-text-primary transition-colors rounded-lg p-1 hover:bg-surface-hover">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
          {message}
        </div>
        <div className="flex items-center justify-end gap-3 p-4 border-t border-border bg-background/30">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            İptal
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onConfirm();
              onCancel();
            }}
          >
            Onayla
          </Button>
        </div>
      </div>
    </div>
  );
};
