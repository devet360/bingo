import { prisma } from '../src/lib/prisma';
import { createStaff } from '../src/services/staff';

/**
 * Bootstraps the first super admin, or issues another one from a trusted shell.
 * Usage:
 *   npm run admin:create -w @bingo/api -- --name "Owner" --email owner@example.com
 *   ... --phone +251912345678  (either email or phone)
 *   ... --password 'temporary' (optional; generated when omitted)
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith('--')) continue;
    const [key, ...rest] = raw.slice(2).split('=');
    if (rest.length > 0) {
      args[key!] = rest.join('=');
    } else if (argv[index + 1] && !argv[index + 1]!.startsWith('--')) {
      args[key!] = argv[index + 1]!;
      index += 1;
    } else {
      args[key!] = '';
    }
  }

  const name = args.name ?? process.env.ADMIN_NAME;
  const email = args.email ?? process.env.ADMIN_EMAIL;
  const phone = args.phone ?? process.env.ADMIN_PHONE;
  const password = args.password ?? process.env.ADMIN_PASSWORD;

  if (!name || (!email && !phone)) {
    console.error(
      'Usage: npm run admin:create -w @bingo/api -- --name "Owner" --email owner@example.com [--password secret]',
    );
    process.exitCode = 1;
    return;
  }

  const duplicate = await prisma.user.findFirst({
    where: { OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] },
    select: { id: true },
  });
  if (duplicate) {
    console.error(`An account already uses that email/phone (user ${duplicate.id}).`);
    process.exitCode = 1;
    return;
  }

  const { user, temporaryPassword } = await createStaff({
    role: 'SUPER_ADMIN',
    displayName: name,
    email,
    phone,
    password,
  });

  console.log('Super admin created.');
  console.log(`  user id:  ${user.id}`);
  console.log(`  login:    ${email ?? phone}`);
  console.log(`  password: ${temporaryPassword}`);
  console.log('Change this password after the first sign-in.');
}

main()
  .catch((error) => {
    console.error('Failed to create super admin:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
