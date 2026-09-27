export type SignUpFlowResult = {
  profileUpdated: boolean;
  verificationSent: boolean;
};

export async function runSignUpFlow<TUser>({
  createUser,
  updateUserProfile,
  sendVerification,
}: {
  createUser: () => Promise<TUser>;
  updateUserProfile: (user: TUser) => Promise<void>;
  sendVerification: (user: TUser) => Promise<void>;
}): Promise<SignUpFlowResult> {
  const user = await createUser();
  let profileUpdated = true;
  let verificationSent = true;
  try {
    await updateUserProfile(user);
  } catch {
    profileUpdated = false;
  }
  try {
    await sendVerification(user);
  } catch {
    verificationSent = false;
  }
  return { profileUpdated, verificationSent };
}
