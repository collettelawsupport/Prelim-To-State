'use client';

import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ageDivisions,
  ageUnits,
  formatCurrency,
  usStates,
} from './registration-data';
import type { RegistrationConfiguration } from './registration-data';

type RegistrationValues = Record<string, string>;
type SignatureKind = 'typed' | 'drawn';
type SavedDraft = { values: RegistrationValues; currentStep: number; submissionKey: string };

function makeSubmissionKey() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SignaturePad({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    canvas.width = Math.max(560, Math.round(canvas.getBoundingClientRect().width * 2));
    canvas.height = 220;
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#51213b';

    if (value.startsWith('data:image/png')) {
      const savedSignature = new Image();
      savedSignature.onload = () => context.drawImage(savedSignature, 0, 0, canvas.width, canvas.height);
      savedSignature.src = value;
    }
  }, [value]);

  const pointFor = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
    };
  };

  const startDrawing = (event: PointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFor(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
  };

  const continueDrawing = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const point = pointFor(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  };

  const finishDrawing = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange(event.currentTarget.toDataURL('image/png'));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    onChange('');
  };

  return (
    <div className="signature-pad-shell">
      <canvas
        ref={canvasRef}
        className="signature-pad"
        tabIndex={0}
        aria-label="Draw parent or guardian signature"
        onPointerDown={startDrawing}
        onPointerMove={continueDrawing}
        onPointerUp={finishDrawing}
        onPointerCancel={finishDrawing}
      />
      <button className="text-button" type="button" onClick={clear}>Clear signature</button>
    </div>
  );
}

function RequiredMark() {
  return <b className="required" aria-label="required">*</b>;
}

export default function RegistrationForm({ configuration }: { configuration: RegistrationConfiguration }) {
  const { workflow } = configuration;
  const { registrationSteps } = configuration;
  const [currentStep, setCurrentStep] = useState(0);
  const [values, setValues] = useState<RegistrationValues>({ signature_kind: 'typed' });
  const [submissionKey, setSubmissionKey] = useState('');
  const [waiverCode, setWaiverCode] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState('Draft ready');
  const [submissionStatus, setSubmissionStatus] = useState<'idle' | 'submitting'>('idle');
  const [submissionError, setSubmissionError] = useState('');
  const [submissionSupportUrl, setSubmissionSupportUrl] = useState('');
  const [submissionReconnectUrl, setSubmissionReconnectUrl] = useState('');
  const [workflowAvailability, setWorkflowAvailability] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [workflowAvailabilityMessage, setWorkflowAvailabilityMessage] = useState('Checking the secure QuickBooks payment connection…');
  const [workflowSupportUrl, setWorkflowSupportUrl] = useState('/support/');
  const [workflowReconnectUrl, setWorkflowReconnectUrl] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(configuration.storageKey);
        if (saved) {
          const draft = JSON.parse(saved) as Partial<SavedDraft>;
          if (draft.values) setValues({ signature_kind: 'typed', ...draft.values });
          if (typeof draft.currentStep === 'number') {
            setCurrentStep(Math.min(Math.max(draft.currentStep, 0), registrationSteps.length - 1));
          }
          setSubmissionKey(draft.submissionKey || makeSubmissionKey());
          setSaveStatus('Draft restored');
        } else {
          setSubmissionKey(makeSubmissionKey());
        }
      } catch {
        setSubmissionKey(makeSubmissionKey());
      } finally {
        setDraftReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [configuration.storageKey, registrationSteps.length]);

  useEffect(() => {
    let active = true;
    fetch(`/api/registration-readiness?workflow=${encodeURIComponent(workflow)}`, { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as {
          message?: string;
          workflowReady?: boolean;
          reconnectRequired?: boolean;
          reconnectUrl?: string;
          supportUrl?: string;
        };
        if (!active) return;
        if (response.ok && result.workflowReady) {
          setWorkflowAvailability('ready');
          setWorkflowAvailabilityMessage('Secure QuickBooks invoicing is ready.');
          return;
        }
        setWorkflowAvailability('unavailable');
        setWorkflowAvailabilityMessage(result.message || 'Online invoice registration is temporarily unavailable.');
        setWorkflowSupportUrl(result.supportUrl || '/support/');
        if (result.reconnectRequired) setWorkflowReconnectUrl(result.reconnectUrl || '/connect/');
      })
      .catch(() => {
        if (!active) return;
        setWorkflowAvailability('unavailable');
        setWorkflowAvailabilityMessage('Online invoice registration is temporarily unavailable. Please contact registration support.');
      });
    return () => { active = false; };
  }, [workflow]);

  useEffect(() => {
    if (!draftReady || !submissionKey) return;
    const timer = window.setTimeout(() => {
      const draft: SavedDraft = { values, currentStep, submissionKey };
      window.localStorage.setItem(configuration.storageKey, JSON.stringify(draft));
      setSaveStatus('Saved on this device');
    }, 300);
    return () => window.clearTimeout(timer);
  }, [configuration.storageKey, currentStep, draftReady, submissionKey, values]);

  const selectedEntry = useMemo(
    () => configuration.entryLevels.find((entry) => entry.value === values.entry_level),
    [configuration.entryLevels, values.entry_level],
  );
  const remainingBalance = selectedEntry ? Math.max(0, selectedEntry.feeCents - configuration.depositCents) : null;
  const current = registrationSteps[currentStep];
  const percent = Math.round(((currentStep + 1) / registrationSteps.length) * 100);
  const signatureKind = (values.signature_kind || 'typed') as SignatureKind;
  const waiverCodeEntered = Boolean(waiverCode.trim());

  const setValue = (name: string, value: string) => {
    setValues((currentValues) => ({ ...currentValues, [name]: value }));
    setSubmissionError('');
    setSubmissionSupportUrl('');
    setSubmissionReconnectUrl('');
  };

  const scrollToForm = () => {
    window.setTimeout(() => document.getElementById('registration-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const validateStep = () => {
    const section = formRef.current?.querySelector<HTMLElement>(`[data-step="${currentStep}"]`);
    const invalid = section?.querySelector<HTMLElement>(':invalid');
    if (invalid) {
      formRef.current?.reportValidity();
      invalid.focus();
      return false;
    }
    if (currentStep === 2 && signatureKind === 'drawn' && !values.signature_data) {
      setSubmissionError('Please draw the parent or guardian signature before creating the invoice.');
      section?.querySelector<HTMLCanvasElement>('canvas')?.focus();
      return false;
    }
    return true;
  };

  const goNext = () => {
    if (!validateStep()) return;
    setCurrentStep((step) => Math.min(step + 1, registrationSteps.length - 1));
    scrollToForm();
  };

  const goBack = () => {
    setSubmissionError('');
    setSubmissionSupportUrl('');
    setSubmissionReconnectUrl('');
    setCurrentStep((step) => Math.max(step - 1, 0));
    scrollToForm();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmissionError('');
    setSubmissionSupportUrl('');
    setSubmissionReconnectUrl('');
    if (!validateStep()) return;

    setSubmissionStatus('submitting');
    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch('/api/submit-registration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflow,
          values,
          submissionKey,
          waiverCode,
          botField: String(formData.get('bot-field') || ''),
        }),
      });
      const result = await response.json().catch(() => ({ message: 'The server returned an unexpected response.' })) as {
        message?: string;
        checkoutUrl?: string;
        reconnectRequired?: boolean;
        reconnectUrl?: string;
        supportUrl?: string;
      };
      if (!response.ok || !result.checkoutUrl) {
        setSubmissionStatus('idle');
        setSubmissionError(result.message || 'The required QuickBooks payment could not be started.');
        if (result.reconnectRequired) {
          setSubmissionSupportUrl(result.supportUrl || '/support/');
          setSubmissionReconnectUrl(result.reconnectUrl || '/connect/');
        }
        return;
      }
      window.localStorage.removeItem(configuration.storageKey);
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      setSubmissionStatus('idle');
      setSubmissionError(error instanceof Error ? error.message : 'The required QuickBooks payment could not be started. Please try again.');
    }
  };

  return (
    <main className="registration-page">
      <header className="site-header">
        <a className="brand" href="#top" aria-label={`Texas Our Little Miss ${workflow === 'prelim' ? 'preliminary' : 'Honor Roll'} registration home`}>
          <span className="brand-mark" aria-hidden="true">OLM</span>
          <span>Texas Our Little Miss</span>
        </a>
        <span className="secure-note">Secure registration · Payment or approved coupon</span>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">{configuration.eyebrow}</p>
        <h1>{configuration.heroTitle}</h1>
        <p className="hero-copy">October 30–November 1, 2026 · College Station, Texas</p>
        <p className="location"><b>Staged events:</b> Texas A&amp;M Hotel and Conference Center</p>
        <p className="location"><b>Host hotel:</b> Texas A&amp;M Hotel, 177 Joe Routt Blvd, College Station, TX 77840</p>
      </section>

      <div className="form-shell" id="registration-form">
        <aside className="progress-card" aria-label={`Step ${currentStep + 1} of ${registrationSteps.length}: ${current.shortTitle}`}>
          <div className="progress-number"><strong>{currentStep + 1}</strong><span>/{registrationSteps.length}</span></div>
          <div><p>{current.shortTitle}</p><small>{percent}% complete</small></div>
        </aside>

        <form ref={formRef} className="form-card" name={`${workflow}-state-registration`} onSubmit={handleSubmit}>
          <p className="honeypot" aria-hidden="true">
            <label>Do not fill this out if you are human:<input name="bot-field" tabIndex={-1} autoComplete="off" /></label>
          </p>

          <nav className="step-dots" aria-label="Registration sections">
            {registrationSteps.map((step, index) => (
              <span key={step.shortTitle} className={index < currentStep ? 'step-dot complete' : index === currentStep ? 'step-dot active' : 'step-dot'}>
                <span className="sr-only">{step.shortTitle}</span>
              </span>
            ))}
          </nav>

          {workflowAvailability !== 'ready' && (
            <article className="info-panel important-panel" role="status">
              <h3>{workflowAvailability === 'checking' ? 'Checking payment connection' : 'Online registration temporarily paused'}</h3>
              <p>{workflowAvailabilityMessage}</p>
              {workflowAvailability === 'unavailable' && <p><a className="text-link" href={workflowSupportUrl}>Contact registration support</a></p>}
              {workflowReconnectUrl && <p><a className="text-link" href={workflowReconnectUrl}>Texas OLM administrator: reconnect QuickBooks</a></p>}
            </article>
          )}

          <section data-step="0" hidden={currentStep !== 0} aria-labelledby="step-0-title">
            <div className="section-heading">
              <p>Step 1 of 3</p>
              <h2 id="step-0-title">Registration information</h2>
              <span>Tell us about the contestant and the parent or guardian who will chaperone her during state weekend.</span>
            </div>
            <article className="info-panel welcome-panel">
              <h3>{configuration.welcomeTitle}</h3>
              <p>{configuration.welcomeCopy}</p>
            </article>
            <div className="field-grid">
              <label className="field"><span>Contestant first name <RequiredMark /></span><input type="text" required={currentStep === 0} autoComplete="given-name" value={values.contestant_first_name || ''} onChange={(event) => setValue('contestant_first_name', event.target.value)} /></label>
              <label className="field"><span>Contestant last name <RequiredMark /></span><input type="text" required={currentStep === 0} autoComplete="family-name" value={values.contestant_last_name || ''} onChange={(event) => setValue('contestant_last_name', event.target.value)} /></label>
              <label className="field"><span>Chaperone first name <RequiredMark /></span><input type="text" required={currentStep === 0} autoComplete="off" value={values.chaperone_first_name || ''} onChange={(event) => setValue('chaperone_first_name', event.target.value)} /></label>
              <label className="field"><span>Chaperone last name <RequiredMark /></span><input type="text" required={currentStep === 0} autoComplete="off" value={values.chaperone_last_name || ''} onChange={(event) => setValue('chaperone_last_name', event.target.value)} /></label>
              <label className="field"><span>Contestant date of birth <RequiredMark /></span><input type="date" required={currentStep === 0} value={values.contestant_date_of_birth || ''} onChange={(event) => setValue('contestant_date_of_birth', event.target.value)} /></label>
              <label className="field"><span>Contestant age on pageant day <RequiredMark /></span><input type="number" min="0" required={currentStep === 0} inputMode="numeric" value={values.contestant_age || ''} onChange={(event) => setValue('contestant_age', event.target.value)} /></label>
              <label className="field"><span>Age is measured in <RequiredMark /></span><select required={currentStep === 0} value={values.age_unit || ''} onChange={(event) => setValue('age_unit', event.target.value)}><option value="" disabled>Select months or years</option>{ageUnits.map((unit) => <option key={unit}>{unit}</option>)}</select><small>Use months for ages 0–2 and years for ages 3 and up.</small></label>
              <label className="field"><span>Age division as of October 1, 2026 <RequiredMark /></span><select required={currentStep === 0} value={values.age_division || ''} onChange={(event) => setValue('age_division', event.target.value)}><option value="" disabled>Choose division</option>{ageDivisions.map((division) => <option key={division}>{division}</option>)}</select></label>
              <label className="field wide"><span>Address <RequiredMark /></span><input type="text" required={currentStep === 0} autoComplete="address-line1" value={values.address_line_1 || ''} onChange={(event) => setValue('address_line_1', event.target.value)} /></label>
              <label className="field"><span>City <RequiredMark /></span><input type="text" required={currentStep === 0} autoComplete="address-level2" value={values.city || ''} onChange={(event) => setValue('city', event.target.value)} /></label>
              <label className="field"><span>State <RequiredMark /></span><select required={currentStep === 0} autoComplete="address-level1" value={values.state || ''} onChange={(event) => setValue('state', event.target.value)}><option value="" disabled>Select state</option>{usStates.map((state) => <option key={state}>{state}</option>)}</select></label>
              <label className="field"><span>ZIP code <RequiredMark /></span><input type="text" required={currentStep === 0} autoComplete="postal-code" inputMode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" placeholder="77840" value={values.zip_code || ''} onChange={(event) => setValue('zip_code', event.target.value)} /></label>
              <label className="field"><span>Phone <RequiredMark /></span><input type="tel" required={currentStep === 0} autoComplete="tel" value={values.phone || ''} onChange={(event) => setValue('phone', event.target.value)} /></label>
              <label className="field wide"><span>Email <RequiredMark /></span><input type="email" required={currentStep === 0} autoComplete="email" placeholder="you@example.com" value={values.email || ''} onChange={(event) => setValue('email', event.target.value)} /></label>
            </div>
          </section>

          <section data-step="1" hidden={currentStep !== 1} aria-labelledby="step-1-title">
            <div className="section-heading">
              <p>Step 2 of 3</p>
              <h2 id="step-1-title">Choose your entry level</h2>
              <span>{configuration.entryIntroduction}</span>
            </div>
            <article className="info-panel important-panel">
              <h3>Important dates and information</h3>
              <ul>{configuration.importantInformation.map((item) => <li key={item}>{item}</li>)}</ul>
            </article>
            <fieldset className="choice-field">
              <legend>Entry level <RequiredMark /></legend>
              <p className="field-help">{configuration.depositHelp}</p>
              <div className="choice-grid">
                {configuration.entryLevels.map((level) => (
                  <label className="choice" key={level.value}>
                    <input type="radio" name="entry-level" value={level.value} checked={values.entry_level === level.value} required={currentStep === 1} onChange={() => setValue('entry_level', level.value)} />
                    <span className="choice-control" aria-hidden="true" />
                    <span className="choice-copy"><b>{level.label}</b><small>Entry fee: {formatCurrency(level.feeCents)}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            {selectedEntry && (
              <aside className="price-card" aria-live="polite">
                <div><span>Selected entry fee</span><strong>{formatCurrency(selectedEntry.feeCents)}</strong></div>
                <div><span>Deposit invoice due now</span><strong>{formatCurrency(configuration.depositCents)}</strong></div>
                <div><span>Remaining entry balance after deposit</span><strong>{formatCurrency(remainingBalance || 0)}</strong></div>
              </aside>
            )}
          </section>

          <section data-step="2" hidden={currentStep !== 2} aria-labelledby="step-2-title">
            <div className="section-heading">
              <p>Step 3 of 3</p>
              <h2 id="step-2-title">Release and required payment</h2>
              <span>{waiverCodeEntered
                ? `Review the release, sign electronically, and submit the approved waiver code for a ${formatCurrency(configuration.waiverCreditCents)} registration credit.`
                : `Review the release, sign electronically, and continue directly to the secure ${formatCurrency(configuration.depositCents)} payment screen from QuickBooks.`}</span>
            </div>
            <article className="info-panel release-panel">
              <h3>Release information</h3>
              {configuration.registrationReleaseText.split('\n\n').map((paragraph) => <p key={paragraph.slice(0, 50)}>{paragraph}</p>)}
            </article>
            <fieldset className="choice-field signature-fieldset">
              <legend>Parent or guardian signature <RequiredMark /></legend>
              <div className="signature-mode" role="group" aria-label="Signature method">
                <button type="button" className={signatureKind === 'typed' ? 'selected' : ''} onClick={() => setValue('signature_kind', 'typed')}>Type</button>
                <button type="button" className={signatureKind === 'drawn' ? 'selected' : ''} onClick={() => setValue('signature_kind', 'drawn')}>Draw</button>
              </div>
              {signatureKind === 'typed' ? (
                <label className="field signature-name"><span>Type your full legal name <RequiredMark /></span><input type="text" required={currentStep === 2} autoComplete="name" value={values.signature_name || ''} onChange={(event) => setValue('signature_name', event.target.value)} /></label>
              ) : (
                <SignaturePad value={values.signature_data || ''} onChange={(signature) => setValue('signature_data', signature)} />
              )}
            </fieldset>
            <label className="release-acceptance">
              <input type="checkbox" required={currentStep === 2} checked={values.release_accepted === 'yes'} onChange={(event) => setValue('release_accepted', event.target.checked ? 'yes' : '')} />
              <span>I am the contestant&apos;s parent or legal guardian (or the contestant is of legal age), and I agree to the release above. <RequiredMark /></span>
            </label>
            <label className="field signature-name">
              <span>Coupon / registration waiver code (optional)</span>
              <input
                type="password"
                autoComplete="off"
                value={waiverCode}
                onChange={(event) => {
                  setWaiverCode(event.target.value);
                  setSubmissionError('');
                }}
              />
              <small>If Texas Our Little Miss gave you a waiver code, enter it here. A valid code means no payment is due today, applies a {formatCurrency(configuration.waiverCreditCents)} credit to the updated registration invoice, and sends the Big Form immediately.</small>
            </label>
            <aside className="invoice-summary" aria-label="Required payment summary">
              <p>{waiverCodeEntered ? 'Coupon code review' : 'Required QuickBooks payment'}</p>
              <div>
                <span>{waiverCodeEntered ? 'Due today with a valid code' : 'Deposit due now'}</span>
                <strong>{formatCurrency(waiverCodeEntered ? 0 : configuration.depositCents)}</strong>
              </div>
              {waiverCodeEntered && <div><span>Credit on updated invoice</span><strong>{formatCurrency(configuration.waiverCreditCents)}</strong></div>}
              <small>{waiverCodeEntered
                ? 'Selecting Submit verifies the code securely. If it is valid, no payment screen opens and the personalized Big Form link is emailed immediately. The code is not saved with the contestant registration.'
                : `Selecting Continue creates and emails the QuickBooks invoice, then opens its secure payment screen. The registration remains pending and the contestant's place is not secured until the deposit is paid. QuickBooks applies the payment to this invoice automatically. ${configuration.afterBigFormCopy}`}</small>
            </aside>
          </section>

          <div className="form-actions">
            <div className="action-meta">
              <span>{saveStatus}</span>
              {submissionError && <p role="alert">{submissionError}</p>}
              {submissionSupportUrl && <a className="text-link" href={submissionSupportUrl}>Contact registration support</a>}
              {submissionReconnectUrl && <a className="text-link" href={submissionReconnectUrl}>Texas OLM administrator: reconnect QuickBooks</a>}
            </div>
            <div className="action-buttons">
              {currentStep > 0 && <button className="button-secondary" type="button" onClick={goBack}>Back</button>}
              {currentStep < registrationSteps.length - 1 ? (
                <button className="button-primary" type="button" onClick={goNext}>Continue <span aria-hidden="true">→</span></button>
              ) : (
                <button className="button-primary" type="submit" disabled={submissionStatus === 'submitting' || workflowAvailability !== 'ready'}>
                  {submissionStatus === 'submitting'
                    ? waiverCodeEntered ? 'Applying coupon…' : 'Opening secure payment…'
                    : workflowAvailability === 'checking'
                      ? 'Checking payment connection…'
                      : workflowAvailability === 'unavailable'
                        ? 'Online registration temporarily paused'
                        : waiverCodeEntered
                          ? 'Submit registration with coupon code'
                          : `Continue to secure ${formatCurrency(configuration.depositCents)} payment`}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      <footer>
        <span>Texas Our Little Miss</span>
        <nav aria-label="Legal and support links"><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="/support/">Support</a></nav>
        <small>Natural beauty · Poise · Confidence · Scholarship</small>
      </footer>
    </main>
  );
}
