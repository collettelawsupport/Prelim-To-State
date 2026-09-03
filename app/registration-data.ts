export type RegistrationWorkflow = 'prelim' | 'honor_roll';

export const DEPOSIT_CENTS = 15_000;
export const HONOR_ROLL_DEPOSIT_CENTS = 10_000;
export const REGISTRATION_WAIVER_CREDIT_CENTS = 10_000;
export const HONOR_ROLL_OPTIONAL_DISCOUNT = 0.5;

export const ageUnits = ['months', 'years'] as const;

export const ageDivisions = [
  '0 - 2 years',
  '3 - 6 years',
  '7 - 9 years',
  '10 - 12 years',
  '13 - 15 years',
  '16 - 20 years',
  '21 - 39 years',
  '40 + years',
] as const;

export const entryLevels = [
  { value: 'preregistration', label: 'PreRegistration before Preliminary Pageant', feeCents: 35_000 },
  { value: 'queen_king', label: 'Won QUEEN/KING at Preliminary Pageant', feeCents: 37_000 },
  { value: 'princess', label: 'Won PRINCESS at Preliminary Pageant', feeCents: 38_000 },
  { value: 'personality_mini_queen', label: 'Won PERSONALITY/MINI QUEEN at Preliminary Pageant', feeCents: 39_000 },
  { value: 'alternate', label: 'Won Alternate at Preliminary Pageant', feeCents: 40_000 },
  { value: 'at_large', label: 'Contestant At-Large (Did not enter a Preliminary Pageant)', feeCents: 66_000 },
] as const;

export const honorRollEntryLevels = [
  { value: 'honor_roll', label: 'Honor Roll Contestant', feeCents: 33_000 },
  { value: 'winners_circle_125', label: "Winner's Circle Contestant — entry fee only", feeCents: 12_500 },
  { value: 'winners_circle_175', label: "Winner's Circle Contestant — entry fee plus contestant and chaperone party tickets", feeCents: 17_500 },
] as const;

export const usStates = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
  'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
  'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
] as const;

export const registrationSteps = [
  { shortTitle: 'Contestant details', title: 'Registration information' },
  { shortTitle: 'Entry level', title: 'Choose your entry level' },
  { shortTitle: 'Release & invoice', title: 'Release and QuickBooks invoice' },
] as const;

export const honorRollRegistrationSteps = [
  { shortTitle: 'Contestant details', title: 'Registration information' },
  { shortTitle: 'Entry level', title: 'Choose your entry level' },
  { shortTitle: 'Release & payment', title: 'Release and required payment' },
] as const;

export const importantInformation = [
  'Required deposit: $150. The deposit is subtracted from the selected entry fee.',
  'Contestants who attended a preliminary pageant receive the discounted entry fee associated with their placement.',
  'The entry fee includes registration, all required competitions, one chaperone badge, contestant and chaperone meal and party tickets, a souvenir program book, and downloadable professional competition photos.',
  'Big Forms, photos, good luck messages, and ads are due October 8, 2026.',
  'Optionals may be paid in advance or at the door.',
  'Submit this form and deposit within five days after the preliminary pageant to receive discounted pricing.',
];

export const honorRollImportantInformation = [
  'Honor Roll entry fee: $330 with a $100 deposit due now. The deposit is subtracted from the entry fee.',
  "Winner's Circle entry fee: $125, or $175 including a party ticket for the contestant and chaperone. A $100 deposit is due now, and contestants must have already paid the World deposit.",
  'Honor Roll optional competitions are 50% off when paid in advance. Optionals paid at the door are regular price.',
  'The remaining entry fee is due on or before October 9, 2026 to lock in the Honor Roll price. After that date, preliminary-contestant pricing applies.',
  'Big Forms, photos, good luck messages, and ads are due October 15, 2026.',
  'The deposit must be paid as part of checkout. QuickBooks will email the paid deposit invoice and the remaining balance after registration.',
];

export const registrationReleaseText = `By electronically signing this form, I understand that this form and the required deposit are due five days after the preliminary pageant. After that date, I may still register the contestant at contestant at-large pricing. I understand that all money received by Texas Our Little Miss is non-refundable and non-transferable if the contestant does not compete at the state competition. This form will secure the contestant's number and entry into the Texas Our Little Miss State Finals, October 30–November 1, 2026, in College Station, Texas.

I understand that Our Little Miss is a three-tier system and that if the contestant wins a top-four title—Queen, Princess, Mini Queen, or Personality Plus—at the state finals, she will be required to attend the World Competition in January 2027. If she does not attend the World Competition, she forfeits the title and all awards received, including crown, banner, and trophy, so the next contestant in line may represent Texas at the World Finals.`;

export const honorRollRegistrationReleaseText = `By electronically signing this form, I understand that the remainder of the contestant's entry fee is due on or before October 9, 2026. After that date, I may still register at preliminary-contestant pricing. I understand that all money received by Texas Our Little Miss is non-refundable and non-transferable if the contestant does not compete at the state competition. This form will secure the contestant's number and entry into the Texas Our Little Miss State Finals, October 30–November 1, 2026, in College Station, Texas.

I understand that Our Little Miss is a three-tier system and that if the contestant wins a top-four title—Queen, Princess, Mini Queen, or Personality Plus—at the state finals, she will be required to attend the World Competition in January 2027. If she does not attend the World Competition, she forfeits the title and all awards received, including crown, banner, and trophy, so the next contestant in line may represent Texas at the World Finals.

Winner's Circle contestants have already paid their World deposit and are attending the World pageant. They cannot win division titles, but they may win optionals they enter and other side awards.`;

export const registrationConfigurations = {
  prelim: {
    workflow: 'prelim',
    storageKey: 'olm-2026-prelim-to-state-draft-v1',
    eyebrow: '2026 State Competition',
    heroTitle: 'State Universal Beauty Competition Registration',
    welcomeTitle: 'Welcome, preliminary contestants!',
    welcomeCopy: 'Complete this registration and the $150 deposit payment to secure the contestant’s state registration and contestant number.',
    entryIntroduction: 'The standard entry fee is $660. Preliminary contestants receive the placement-based discounted entry fee shown below.',
    depositHelp: 'The required $150 deposit is subtracted from the selected entry fee.',
    afterBigFormCopy: 'After payment, the contestant receives the Big Form; completing it updates this invoice with the remaining entry fee and selected optionals.',
    invitationCompletionCopy: 'After the Big Form is submitted, QuickBooks will email the updated invoice with the remaining entry fee and selected optional competitions.',
    finalInvoiceMemo: 'The remaining entry fee and known selected optional competitions are included.',
    depositDueLabel: 'October 8, 2026',
    finalInvoiceDueDate: '2026-10-08',
    depositCents: DEPOSIT_CENTS,
    entryLevels,
    registrationSteps,
    importantInformation,
    registrationReleaseText,
  },
  honor_roll: {
    workflow: 'honor_roll',
    storageKey: 'olm-2026-honor-roll-to-state-draft-v1',
    eyebrow: '2026 Honor Roll Registration',
    heroTitle: 'State Universal Beauty Competition',
    welcomeTitle: 'Welcome, Honor Roll contestants!',
    welcomeCopy: 'This form is for contestants who have entered a Texas Our Little Miss state pageant in the past. Complete the registration and required deposit payment to secure the contestant’s state registration and contestant number.',
    entryIntroduction: 'Select the Honor Roll or Winner’s Circle entry that applies to the contestant.',
    depositHelp: 'The $100 registration deposit is subtracted from the selected entry fee.',
    afterBigFormCopy: 'After payment, the contestant receives the Big Form; completing it updates this invoice with the remaining entry fee, 50%-off eligible Honor Roll optionals, and any full-price tickets or advertising.',
    invitationCompletionCopy: 'After the Big Form is submitted, QuickBooks will email the updated invoice with the remaining entry fee, 50%-off eligible Honor Roll optionals, and any full-price tickets or advertising.',
    finalInvoiceMemo: 'Eligible optional competitions are billed at the Honor Roll 50% price; tickets and advertising remain full price.',
    depositDueLabel: 'October 9, 2026',
    finalInvoiceDueDate: '2026-10-09',
    depositCents: HONOR_ROLL_DEPOSIT_CENTS,
    entryLevels: honorRollEntryLevels,
    registrationSteps: honorRollRegistrationSteps,
    importantInformation: honorRollImportantInformation,
    registrationReleaseText: honorRollRegistrationReleaseText,
  },
} as const;

export type RegistrationConfiguration = (typeof registrationConfigurations)[RegistrationWorkflow];

export const requiredRegistrationFields = [
  'contestant_first_name', 'contestant_last_name', 'chaperone_first_name', 'chaperone_last_name',
  'contestant_date_of_birth', 'contestant_age', 'age_unit', 'address_line_1', 'city', 'state',
  'zip_code', 'phone', 'email', 'age_division', 'entry_level', 'signature_kind', 'release_accepted',
] as const;

export function formatCurrency(cents: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function registrationConfigurationFor(workflow: RegistrationWorkflow) {
  return registrationConfigurations[workflow];
}

export function entryLevelFor(value: string, workflow: RegistrationWorkflow = 'prelim') {
  return registrationConfigurationFor(workflow).entryLevels.find((level) => level.value === value);
}
