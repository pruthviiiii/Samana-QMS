'use client';
import { useState, useEffect, useRef } from 'react';
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
      'No linked units were found. Please ask reception to verify your account.',
    finding: 'Finding your account…',
    issuing: 'Issuing…',
    verified: 'Account found',
    autoSelected: 'Selected',
    linkedUnits: 'linked units',
    saved: 'Your ticket is saved. Printing again will not create a duplicate.',
    privacy:
      'Your details are used to find your account and are kept with the record of this visit.',
    passportHint: 'Enter passport number',
    headquarters: 'Samana Headquarters',
    assistance: 'General assistance',
    crmTitle: 'CRM',
    collectionTitle: 'Collection',
    noUnitsGeneral:
      'No active units are linked to this account yet. We will register a General Query visit and our team will help you at the desk.',
    walkInPrompt:
      'Salesforce cannot be reached right now. You can still register this customer as a walk-in General Query visit; their details are matched later.',
    walkInButton: 'Register walk-in visit',
    services: {
      'crm-general': 'General Query',
      'crm-noc': 'NOC / Resale',
      'crm-refund': 'Refund',
      'crm-handover': 'Handover',
    },
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
    finding: 'جارٍ البحث عن حسابك…',
    issuing: 'جارٍ إصدار التذكرة…',
    verified: 'تم العثور على الحساب',
    autoSelected: 'تم الاختيار',
    linkedUnits: 'وحدات مرتبطة',
    saved: 'تم حفظ تذكرتك. لن تؤدي إعادة الطباعة إلى إصدار تذكرة جديدة.',
    privacy: 'تُستخدم بياناتك للعثور على حسابك وتُحفظ مع سجل هذه الزيارة.',
    passportHint: 'أدخل رقم جواز السفر',
    headquarters: 'المقر الرئيسي لسمانا',
    assistance: 'المساعدة العامة',
    crmTitle: 'علاقات العملاء',
    collectionTitle: 'التحصيل',
    noUnitsGeneral:
      'لا توجد وحدات نشطة مرتبطة بهذا الحساب حالياً. سنسجل زيارة استفسار عام وسيساعدك فريقنا في المكتب.',
    walkInPrompt:
      'تعذر الوصول إلى سيلزفورس حالياً. يمكن تسجيل العميل كزيارة استفسار عام وسيتم التحقق من بياناته لاحقاً.',
    walkInButton: 'تسجيل زيارة بدون حساب',
    services: {
      'crm-general': 'استفسار عام',
      'crm-noc': 'شهادة عدم ممانعة / إعادة بيع',
      'crm-refund': 'استرداد المبلغ',
      'crm-handover': 'تسليم الوحدة',
    },
  },
};
type Lookup = { lookupId: string; customer: Customer; expiresAt: string };
export default function CheckIn({
  onIssued,
  allowWalkIn = false,
  fullPage = false,
}: {
  onIssued?: (ticket: Ticket) => void;
  // Staff consoles may register a walk-in when Salesforce is unreachable.
  allowWalkIn?: boolean;
  // On the customer's phone the whole page follows the chosen language.
  fullPage?: boolean;
}) {
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const t = translations[language];
  useEffect(() => {
    try {
      if (localStorage.getItem('qms-lang') === 'ar') setLanguage('ar');
    } catch {
      /* storage unavailable */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('qms-lang', language);
    } catch {
      /* storage unavailable */
    }
    if (!fullPage) return;
    const root = document.documentElement;
    root.lang = language;
    root.dir = language === 'ar' ? 'rtl' : 'ltr';
    return () => {
      root.lang = 'en';
      root.dir = 'ltr';
    };
  }, [language, fullPage]);
  const [offline, setOffline] = useState(false);
  const [type, setType] = useState<IdentifierType>('mobile');
  const [value, setValue] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [department, setDepartment] = useState('CRM');
  const [service, setService] = useState('crm-general');
  const [unit, setUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [requestId, setRequestId] = useState('');
  const stepRef = useRef<HTMLDivElement>(null);
  const identifierRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (lookup || ticket) stepRef.current?.focus();
  }, [lookup, ticket]);
  const reset = () => {
    setValue('');
    setLookup(null);
    setUnit('');
    setTicket(null);
    setError('');
    setRequestId('');
    setOffline(false);
  };
  function apply(data: Lookup) {
    setLookup(data);
    setRequestId(crypto.randomUUID());
    setOffline(false);
    // A registered account with no active units is served as General Query.
    const withUnits =
      data.customer.registered && data.customer.units.length > 0;
    setUnit(data.customer.units.length === 1 ? data.customer.units[0].id : '');
    setDepartment(withUnits ? 'CRM' : 'General Query');
    setService(withUnits ? 'crm-general' : 'general');
  }
  async function find(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setOffline(false);
    try {
      apply(await post<Lookup>('customers/lookup', { type, value }));
    } catch (e) {
      setError((e as Error).message);
      const status = (e as Error & { status?: number }).status;
      // Salesforce down: reception can still register a walk-in visit.
      if (allowWalkIn && (status === 502 || status === 503)) setOffline(true);
    } finally {
      setBusy(false);
    }
  }
  async function walkIn() {
    setBusy(true);
    setError('');
    try {
      apply(
        await post<Lookup>('customers/lookup', { type, value, walkIn: true }),
      );
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
    <section
      className="checkin"
      lang={language}
      dir={language === 'ar' ? 'rtl' : 'ltr'}
    >
      <div className="checkin-top">
        <div>
          <p className="eyebrow">SAMANA CUSTOMER EXPERIENCE</p>
          <h2>{t.welcome}</h2>
          <p>{t.intro}</p>
        </div>
        <div className="language-toggle">
          <button
            className={language === 'en' ? 'active' : ''}
            aria-pressed={language === 'en'}
            onClick={() => setLanguage('en')}
          >
            English
          </button>
          <button
            lang="ar"
            className={language === 'ar' ? 'active' : ''}
            aria-pressed={language === 'ar'}
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
        <div className="ticket-success" ref={stepRef} tabIndex={-1}>
          <span className="success-ring">
            <Check size={28} />
          </span>
          <p className="eyebrow">{t.success}</p>
          <strong>{ticket.number}</strong>
          <h3>{ticket.service_name}</h3>
          <p>{t.wait}</p>
          <div className="receipt-details">
            <span>{ticket.project_name || t.headquarters}</span>
            <span>{ticket.unit_name || t.assistance}</span>
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
          <small>{t.saved}</small>
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
                aria-pressed={type === key}
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
              ref={identifierRef}
              aria-invalid={!!error}
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
                    : t.passportHint
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
            {busy ? t.finding : t.lookup}
          </Button>
          {offline && (
            <div className="notice">
              <p>{t.walkInPrompt}</p>
              <Button
                type="button"
                variant="outline"
                onClick={walkIn}
                disabled={busy}
              >
                {t.walkInButton}
              </Button>
            </div>
          )}
          <p className="privacy-note">{t.privacy}</p>
        </form>
      ) : (
        <div className="stack">
          <div className="customer-card" ref={stepRef} tabIndex={-1}>
            <span className="avatar large">
              <UserRound size={23} />
            </span>
            <div>
              <h3>
                {lookup.customer.registered ? lookup.customer.name : t.notfound}
              </h3>
              <p>
                {lookup.customer.registered
                  ? `${lookup.customer.units.length} ${t.linkedUnits}`
                  : t.general}
              </p>
            </div>
            {lookup.customer.registered && (
              <span className="verified">
                <Check size={13} /> {t.verified}
              </span>
            )}
          </div>
          {lookup.customer.registered && lookup.customer.units.length === 0 && (
            <p className="notice">{t.noUnitsGeneral}</p>
          )}
          {lookup.customer.registered && lookup.customer.units.length > 0 && (
            <>
              <div>
                <label>{t.department}</label>
                <div className="department-options">
                  <button
                    className={department === 'CRM' ? 'active' : ''}
                    aria-pressed={department === 'CRM'}
                    onClick={() => {
                      setDepartment('CRM');
                      setService('crm-general');
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    <UserRound size={22} />
                    <strong>{t.crmTitle}</strong>
                    <small>{t.crm}</small>
                  </button>
                  <button
                    className={department === 'Collection' ? 'active' : ''}
                    aria-pressed={department === 'Collection'}
                    onClick={() => {
                      setDepartment('Collection');
                      setService('collection');
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    <Building2 size={22} />
                    <strong>{t.collectionTitle}</strong>
                    <small>{t.collection}</small>
                  </button>
                </div>
              </div>
              {department === 'CRM' && (
                <div>
                  <label id="checkin-service-label">{t.service}</label>
                  <fieldset
                    className="service-choice-grid"
                    aria-labelledby="checkin-service-label"
                  >
                    {SERVICES.filter((s) => s.department === 'CRM').map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={service === s.id}
                        onClick={() => {
                          setService(s.id);
                          setRequestId(crypto.randomUUID());
                        }}
                      >
                        <i />
                        {t.services[s.id as keyof typeof t.services]}
                      </button>
                    ))}
                  </fieldset>
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
                    <span className="badge serving">{t.autoSelected}</span>
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
              disabled={busy || (service !== 'general' && !unit)}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <ArrowRight size={16} />
              )}{' '}
              {busy ? t.issuing : t.issue}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
