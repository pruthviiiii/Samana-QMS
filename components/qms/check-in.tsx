'use client';
import { useState } from 'react';
import {
  Search,
  ArrowRight,
  ArrowLeft,
  Check,
  Printer,
  Building2,
  UserRound,
  Phone,
  FileBadge,
  IdCard,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post } from '@/lib/client';
import {
  SERVICES,
  type Customer,
  type Ticket,
  type IdentifierType,
} from '@/lib/domain';
const translations = {
  en: {
    welcome: 'A warm welcome to Samana',
    intro: 'Let’s connect you with the right team.',
    identify: 'Find your account',
    type: 'How would you like to identify yourself?',
    mobile: 'Mobile number',
    emiratesId: 'Emirates ID',
    passportNumber: 'Passport number',
    lookup: 'Find my details',
    details: 'Your details',
    notfound: 'Welcome, walk-in guest',
    general: 'We’ll connect you to our General Query team.',
    department: 'How can we help you today?',
    crm: 'Customer relations',
    collection: 'Payments & collections',
    service: 'Choose a service',
    unit: 'Choose your unit',
    issue: 'Issue ticket',
    back: 'Start again',
    success: 'You’re in the queue',
    wait: 'Please take a seat. Your ticket number will be called when your agent is ready.',
    print: 'Print ticket',
    next: 'Welcome the next customer',
    sms: 'Ticket SMS is available for registered mobile check-ins.',
    noSms: 'SMS is not sent for Emirates ID or passport check-ins.',
    select: 'Select a unit',
    noUnits:
      'No units were returned by Salesforce. Please ask reception to verify your account.',
  },
  ar: {
    welcome: 'أهلاً بكم في سمانا',
    intro: 'دعنا نوصلك بالفريق المناسب.',
    identify: 'البحث عن حسابك',
    type: 'كيف ترغب في التعريف بنفسك؟',
    mobile: 'رقم الهاتف المتحرك',
    emiratesId: 'الهوية الإماراتية',
    passportNumber: 'رقم جواز السفر',
    lookup: 'البحث عن بياناتي',
    details: 'بياناتك',
    notfound: 'مرحباً بك',
    general: 'سنوصلك بفريق الاستفسارات العامة.',
    department: 'كيف يمكننا مساعدتك اليوم؟',
    crm: 'علاقات العملاء',
    collection: 'المدفوعات والتحصيل',
    service: 'اختر الخدمة',
    unit: 'اختر وحدتك',
    issue: 'إصدار تذكرة',
    back: 'البدء من جديد',
    success: 'أنت الآن في قائمة الانتظار',
    wait: 'يرجى الجلوس. سيتم استدعاء رقم تذكرتك عندما يصبح الموظف جاهزاً.',
    print: 'طباعة التذكرة',
    next: 'استقبال العميل التالي',
    sms: 'الرسائل النصية متاحة عند التسجيل برقم الهاتف المسجل.',
    noSms: 'لا يتم إرسال رسائل عند التسجيل بالهوية أو جواز السفر.',
    select: 'اختر وحدة',
    noUnits: 'لم يتم العثور على وحدات. يرجى مراجعة الاستقبال للتحقق من حسابك.',
  },
};
export default function CheckIn({
  onIssued,
}: {
  onIssued?: (ticket: Ticket) => void;
}) {
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const t = translations[language];
  const [type, setType] = useState<IdentifierType>('mobile');
  const [value, setValue] = useState('');
  const [lookup, setLookup] = useState<{
    lookupId: string;
    customer: Customer;
    expiresAt: string;
  } | null>(null);
  const [department, setDepartment] = useState('CRM');
  const [service, setService] = useState('crm-general');
  const [unit, setUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [requestId, setRequestId] = useState('');
  const reset = () => {
    setValue('');
    setLookup(null);
    setUnit('');
    setTicket(null);
    setError('');
    setRequestId('');
  };
  async function find(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await post<{
        lookupId: string;
        customer: Customer;
        expiresAt: string;
      }>('customers/lookup', { type, value });
      setLookup(data);
      setRequestId(crypto.randomUUID());
      setUnit(
        data.customer.units.length === 1 ? data.customer.units[0].id : '',
      );
      setDepartment(data.customer.registered ? 'CRM' : 'General Query');
      setService(data.customer.registered ? 'crm-general' : 'general');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function issue() {
    if (!lookup) return;
    setBusy(true);
    setError('');
    try {
      const result = await post<Ticket>('tickets', {
        lookupId: lookup.lookupId,
        serviceId: service,
        unitId: unit || null,
        requestId,
      });
      setTicket(result);
      onIssued?.(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="checkin" dir={language === 'ar' ? 'rtl' : 'ltr'}>
      <div className="checkin-top">
        <div>
          <p className="eyebrow">SAMANA CUSTOMER EXPERIENCE</p>
          <h2>{t.welcome}</h2>
          <p>{t.intro}</p>
        </div>
        <div className="language-toggle">
          <button
            className={language === 'en' ? 'active' : ''}
            onClick={() => setLanguage('en')}
          >
            English
          </button>
          <button
            lang="ar"
            className={language === 'ar' ? 'active' : ''}
            onClick={() => setLanguage('ar')}
          >
            العربية
          </button>
        </div>
      </div>
      {!ticket && (
        <div className="checkin-steps">
          <span className={!lookup ? 'current' : 'done'}>
            <b>{lookup ? <Check size={13} /> : 1}</b>
            {t.identify}
          </span>
          <i />
          <span className={lookup ? 'current' : ''}>
            <b>2</b>
            {t.details}
          </span>
          <i />
          <span>
            <b>3</b>
            {t.issue}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {ticket ? (
        <div className="ticket-success">
          <span className="success-ring">
            <Check size={28} />
          </span>
          <p className="eyebrow">{t.success}</p>
          <strong>{ticket.number}</strong>
          <h3>{ticket.service_name}</h3>
          <p>{t.wait}</p>
          <div className="receipt-details">
            <span>{ticket.project_name || 'Samana Headquarters'}</span>
            <span>{ticket.unit_name || 'General assistance'}</span>
          </div>
          <div className="section-actions">
            <Button
              onClick={() =>
                window.open(
                  '/print/' + ticket.id,
                  '_blank',
                  'noopener,noreferrer',
                )
              }
            >
              <Printer size={16} />
              {t.print}
            </Button>
            <Button variant="outline" onClick={reset}>
              {t.next}
              <ArrowRight size={16} />
            </Button>
          </div>
          <small>
            The ticket is saved. Printing again does not create a duplicate.
          </small>
        </div>
      ) : !lookup ? (
        <form onSubmit={find}>
          <div>
            <h3>{t.identify}</h3>
            <p className="muted">{t.type}</p>
          </div>
          <div className="identity-options">
            {(
              [
                ['mobile', Phone],
                ['emiratesId', IdCard],
                ['passportNumber', FileBadge],
              ] as const
            ).map(([key, Icon]) => (
              <button
                type="button"
                key={key}
                className={
                  type === key ? 'identity-option active' : 'identity-option'
                }
                onClick={() => {
                  setType(key);
                  setValue('');
                  setError('');
                }}
              >
                <Icon size={21} />
                <span>{t[key]}</span>
                {type === key && <Check size={14} />}
              </button>
            ))}
          </div>
          <div>
            <label htmlFor="identifier">{t[type]}</label>
            <Input
              id="identifier"
              className="form-control identifier"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode={type === 'mobile' ? 'tel' : 'text'}
              autoComplete="off"
              maxLength={type === 'emiratesId' ? 18 : 25}
              placeholder={
                type === 'mobile'
                  ? '971 50 123 4567'
                  : type === 'emiratesId'
                    ? '784-XXXX-XXXXXXX-X'
                    : 'Enter passport number'
              }
              required
              dir="ltr"
            />
            <small className="field-hint">
              {type === 'mobile' ? t.sms : t.noSms}
            </small>
          </div>
          <Button
            className="primary-action"
            type="submit"
            disabled={busy || !value.trim()}
          >
            {busy ? (
              <Loader2 size={17} className="spin" />
            ) : (
              <Search size={17} />
            )}{' '}
            {busy ? 'Finding your account…' : t.lookup}
          </Button>
          <p className="privacy-note">
            Your details are used only to identify your account and manage this
            visit.
          </p>
        </form>
      ) : (
        <div className="stack">
          <div className="customer-card">
            <span className="avatar large">
              <UserRound size={23} />
            </span>
            <div>
              <h3>
                {lookup.customer.registered ? lookup.customer.name : t.notfound}
              </h3>
              <p>
                {lookup.customer.registered
                  ? `${lookup.customer.units.length} linked ${lookup.customer.units.length === 1 ? 'unit' : 'units'} · Salesforce verified`
                  : t.general}
              </p>
            </div>
            {lookup.customer.registered && (
              <span className="verified">
                <Check size={13} /> Verified
              </span>
            )}
          </div>
          {lookup.customer.registered && (
            <>
              <div>
                <label>{t.department}</label>
                <div className="department-options">
                  <button
                    className={department === 'CRM' ? 'active' : ''}
                    onClick={() => {
                      setDepartment('CRM');
                      setService('crm-general');
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    <UserRound size={22} />
                    <strong>CRM</strong>
                    <small>{t.crm}</small>
                  </button>
                  <button
                    className={department === 'Collection' ? 'active' : ''}
                    onClick={() => {
                      setDepartment('Collection');
                      setService('collection');
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    <Building2 size={22} />
                    <strong>Collection</strong>
                    <small>{t.collection}</small>
                  </button>
                </div>
              </div>
              {department === 'CRM' && (
                <div>
                  <label htmlFor="checkin-service">{t.service}</label>
                  <select
                    id="checkin-service"
                    className="form-control"
                    value={service}
                    onChange={(e) => {
                      setService(e.target.value);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    {SERVICES.filter((s) => s.department === 'CRM').map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor="checkin-unit">{t.unit}</label>
                {lookup.customer.units.length === 0 ? (
                  <p className="notice">{t.noUnits}</p>
                ) : lookup.customer.units.length === 1 ? (
                  <div className="unit-card">
                    <Building2 size={21} />
                    <div>
                      <strong>{lookup.customer.units[0].name}</strong>
                      <small>
                        {lookup.customer.units[0].project} · SB{' '}
                        {lookup.customer.units[0].bookingNumber || '—'}
                      </small>
                    </div>
                    <span className="badge serving">Auto-selected</span>
                  </div>
                ) : (
                  <select
                    id="checkin-unit"
                    className="form-control"
                    value={unit}
                    onChange={(e) => {
                      setUnit(e.target.value);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    <option value="">{t.select}</option>
                    {lookup.customer.units.map((u) => (
                      <option value={u.id} key={u.id}>
                        {u.project} · {u.name} · {u.bookingNumber}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </>
          )}
          <div className="checkin-actions">
            <Button variant="outline" onClick={reset} disabled={busy}>
              <ArrowLeft size={16} />
              {t.back}
            </Button>
            <Button
              className="primary-action"
              onClick={issue}
              disabled={busy || (lookup.customer.registered && !unit)}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <ArrowRight size={16} />
              )}{' '}
              {busy ? 'Issuing…' : t.issue}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
