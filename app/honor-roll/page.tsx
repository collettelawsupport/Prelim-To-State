import RegistrationForm from '../registration-form';
import { registrationConfigurationFor } from '../registration-data';

export default function HonorRollRegistrationPage() {
  return <RegistrationForm configuration={registrationConfigurationFor('honor_roll')} />;
}
