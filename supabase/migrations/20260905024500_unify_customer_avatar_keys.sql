-- Store the illustrated avatar selection as a stable key so every client can render the same artwork.
UPDATE public.simulated_customers
SET customer_avatar = CASE
  WHEN is_super THEN 'customer-avatar:vip:' || floor(random() * 32)::int::text
  ELSE 'customer-avatar:regular:' || floor(random() * 50)::int::text
END
WHERE customer_avatar IS NULL
   OR customer_avatar !~ '^customer-avatar:(regular|vip):[0-9]+$';
