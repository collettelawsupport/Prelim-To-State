export const DEPOSIT_CENTS = 15_000;

export const ageUnits = ['months', 'years'] as const;

export const ageDivisions = [
  '0 - 2 years',
  '3 - 6 years',
  '7 - 9 years',
  '10 - 12 years',
  '13 - 15 years',
  '16 - 20 years',
  '21 - 28 years',
  '29 + years',
] as const;

export const entryLevels = [
  { value: 'preregistration', label: 'PreRegistration before Preliminary Pageant', feeCents: 35_000 },
  { value: 'queen_king', label: 'Won QUEEN/KING at Preliminary Pageant', feeCents: 37_000 },
  { value: 'princess', label: 'Won PRINCESS at Preliminary Pageant', feeCents: 38_000 },
  { value: 'personality_mini_queen', label: 'Won PERSONALITY/MINI QUEEN at Preliminary Pageant', feeCents: 39_000 },
  { value: 'alternate', label: 'Won Alternate at Preliminary Pageant', feeCents: 40_000 },
  { value: 'at_large', label: 'Contestant At-Large (Did not enter a Preliminary Pageant)', feeCents: 66_000 },
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

export const importantInformation = [
  'Required deposit: $150. The deposit is subtracted from the selected entry fee.',
  'Contestants who attended a preliminary pageant receive the discounted entry fee associated with their placement.',
  'The entry fee includes registration, all required competitions, one chaperone badge, contestant and chaperone meal and party tickets, a souvenir program book, and downloadable professional competition photos.',
  'Big Forms, photos, good luck messages, and ads are due October 8, 2026.',
  'Optionals may be paid in advance or at the door.',
  'Submit this form and deposit within five days after the preliminary pageant to receive discounted pricing.',
];

export const registrationReleaseText = `By electronically signing this form, I understand that this form and the required deposit are due five days after the preliminary pageant. After that date, I may still register the contestant at contestant at-large pricing. I understand that all money received by Texas Our Little Miss is non-refundable and non-transferable if the contestant does not compete at the state competition. This form will secure the contestant's number and entry into the Texas Our Little Miss State Finals, October 30–November 1, 2026, in College Station, Texas.

I understand that Our Little Miss is a three-tier system and that if the contestant wins a top-four title—Queen, Princess, Mini Queen, or Personality Plus—at the state finals, she will be required to attend the World Competition in January 2027. If she does not attend the World Competition, she forfeits the title and all awards received, including crown, banner, and trophy, so the next contestant in line may represent Texas at the World Finals.`;

export const requiredRegistrationFields = [
  'contestant_first_name', 'contestant_last_name', 'chaperone_first_name', 'chaperone_last_name',
  'contestant_date_of_birth', 'contestant_age', 'age_unit', 'address_line_1', 'city', 'state',
  'zip_code', 'phone', 'email', 'age_division', 'entry_level', 'signature_kind', 'release_accepted',
] as const;

export function formatCurrency(cents: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function entryLevelFor(value: string) {
  return entryLevels.find((level) => level.value === value);
}
