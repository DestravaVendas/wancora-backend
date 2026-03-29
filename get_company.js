
import { createClient } from "@supabase/supabase-js";
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getCompany() {
    const { data, error } = await supabase.from('companies').select('id').limit(1);
    if (error) {
        console.error(error);
        process.exit(1);
    }
    console.log(data[0]?.id);
}

getCompany();
