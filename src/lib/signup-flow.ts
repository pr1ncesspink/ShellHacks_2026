export type SignUpFlowResult<TUser> = {
  user: TUser;
  profileUpdated: boolean;
  verificationSent: boolean;
  profileError?: unknown;
  verificationError?: unknown;
};

export async function runSignUpFlow<TUser>({
  createUser,
  updateUserProfile,
  sendVerification,
}: {
  createUser: () => Promise<TUser>;
  updateUserProfile: (user: TUser) => Promise<void>;
  sendVerification: (user: TUser) => Promise<void>;
}): Promise<SignUpFlowResult<TUser>> {
  const user = await createUser();
  let profileError: unknown;
  let verificationError: unknown;
  try {
    await updateUserProfile(user);
  } catch (error) {
    profileError = error;
  }
  try {
    await sendVerification(user);
  } catch (error) {
    verificationError = error;
  }
  return {
    user,
    profileUpdated: profileError === undefined,
    verificationSent: verificationError === undefined,
    ...(profileError === undefined ? {} : { profileError }),
    ...(verificationError === undefined ? {} : { verificationError }),
  };
}
