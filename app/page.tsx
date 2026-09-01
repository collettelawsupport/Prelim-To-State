import RegistrationForm from './registration-form';
import { registrationConfigurationFor } from './registration-data';

export default function PreliminaryRegistrationPage() {
  return <RegistrationForm configuration={registrationConfigurationFor('prelim')} />;
}
