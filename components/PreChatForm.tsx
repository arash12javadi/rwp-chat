import { useState, type FormEvent } from 'react';
import { t } from '../../../src/lib/i18n';
import { preChatFieldLabels } from '../lib/settings';
import type { Lead } from '../hooks/useChatSession';
import type { PreChatField } from '../lib/types';

/**
 * The lead form shown before the conversation starts.
 *
 * Which fields appear and which are required is a site setting; chat_prechat_required is
 * narrowed to chat_prechat_fields when the settings are read, so a field can never be required
 * without also being shown. "Skip" is offered whenever nothing is required, because a support
 * form that refuses to let someone ask a question is not support.
 */

interface PreChatFormProps {
  fields: PreChatField[];
  required: PreChatField[];
  welcome: string;
  busy: boolean;
  onSubmit: (lead: Lead) => void;
}

const inputType: Record<PreChatField, string> = { name: 'text', email: 'email', phone: 'tel' };
const autoComplete: Record<PreChatField, string> = { name: 'name', email: 'email', phone: 'tel' };

export default function PreChatForm({ fields, required, welcome, busy, onSubmit }: PreChatFormProps) {
  const [values, setValues] = useState<Lead>({});
  const [problem, setProblem] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = required.find((field) => !(values[field] || '').trim());
    if (missing) {
      setProblem(t('chat.prechat.missing', 'Please fill in your {field}.', {
        field: t(`chat.prechat.field.${missing}`, preChatFieldLabels[missing]).toLowerCase(),
      }));
      return;
    }
    // Checked here as well as by the browser, because a required email with a typo in it is a
    // lead nobody can follow up.
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email.trim())) {
      setProblem(t('chat.prechat.bad_email', 'That email address does not look right.'));
      return;
    }
    setProblem('');
    onSubmit(values);
  };

  return (
    <form className="rwp-chat-form" onSubmit={submit}>
      <p>{welcome}</p>
      {fields.map((field) => (
        <label key={field}>
          {t(`chat.prechat.field.${field}`, preChatFieldLabels[field])}
          {required.includes(field) ? ' *' : ''}
          <input
            type={inputType[field]}
            autoComplete={autoComplete[field]}
            value={values[field] || ''}
            onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))}
            required={required.includes(field)}
          />
        </label>
      ))}
      {problem && <p className="rwp-chat-error" role="alert">{problem}</p>}
      <button type="submit" className="rwp-chat-button" disabled={busy}>
        {busy ? t('chat.prechat.starting', 'Starting…') : t('chat.prechat.start', 'Start chatting')}
      </button>
      {required.length === 0 && (
        <button type="button" className="rwp-chat-button rwp-chat-button-ghost" disabled={busy} onClick={() => onSubmit({})}>
          {t('chat.prechat.skip', 'Skip')}
        </button>
      )}
    </form>
  );
}
