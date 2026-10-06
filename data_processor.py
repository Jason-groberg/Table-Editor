import re
import numpy as np
import pandas as pd
from google_client import search_google_places
from scraper import scrape_company_domain

def split_name(full_name):
    if pd.isna(full_name):
        return "", ""
    parts = str(full_name).strip().split(" ", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    elif len(parts) == 1:
        return parts[0], ""
    return "", ""

def normalize_col_name(col):
    s = str(col).strip().lower()
    s = s.replace(".", "").replace("'", "").replace("’", "")
    return re.sub(r"[\s\-_]+", " ", s).strip()

COLUMN_ALIASES = {
    "Date of last door pull": {"date added", "date of last door pull"},
    "contact owner": {"am sup", "contact owner", "am-sup", "amsup"},
    "company name": {"account name", "company name"},
    "address": {"building address", "address"},
    "city": {"building city", "city"},
    "zip": {"building zip code", "building zip", "zip", "zip code"},
    "email": {"clients email", "client email", "email"},
    "phone": {"clients phone number", "client phone number", "phone", "phone number"},
    "Client's Full name": {"clients full name", "full name"},
    "First name": {"first name"},
    "last name": {"last name"},
    "Company domain": {"company domain", "domain"},
    "State": {"state"},
    "is doorpull": {"is doorpull", "doorpull"}
}

def process_data(df):
    """
    Process the raw dataframe into the HubSpot ready format.
    """
    # 1. Rename columns according to mapping
    column_mapping = {
        "Date added": "Date of last door pull",
        "AM-Sup": "contact owner",
        "AM - SUP": "contact owner",
        "AM-SUP": "contact owner",
        "AM - Sup": "contact owner",
        "AM_SUP": "contact owner",
        "AM SUP": "contact owner",
        "Account Name": "company name",
        "Building address": "address",
        "Building City": "city",
        "Building zip code": "zip",
        "Client's email.": "email",
        "Client's Phone number.": "phone"
    }

    # Clean header whitespace and map columns with alias fallback
    clean_df = df.copy()
    clean_df.columns = [str(c).strip() for c in clean_df.columns]

    mapped_cols = {}
    for col in clean_df.columns:
        # Check direct mapping first
        target = column_mapping.get(col)
        if not target:
            # Check normalized aliases
            norm = normalize_col_name(col)
            for tgt, aliases in COLUMN_ALIASES.items():
                if norm in aliases:
                    target = tgt
                    break

        target_name = target if target else col
        if target_name not in mapped_cols:
            mapped_cols[target_name] = clean_df[col].copy()
        else:
            s1 = mapped_cols[target_name].replace(r"^\s*$", np.nan, regex=True)
            s2 = clean_df[col].replace(r"^\s*$", np.nan, regex=True)
            mapped_cols[target_name] = s1.combine_first(s2).fillna("")

    processed_df = pd.DataFrame(mapped_cols)
    
    # 2. Split "Client's Full name" into "First name" and "last name"
    if "Client's Full name" in processed_df.columns:
        names = processed_df["Client's Full name"].apply(split_name)
        extracted_first = pd.Series([n[0] for n in names], index=processed_df.index)
        extracted_last = pd.Series([n[1] for n in names], index=processed_df.index)

        if "First name" in processed_df.columns:
            processed_df["First name"] = processed_df["First name"].replace(r"^\s*$", np.nan, regex=True).combine_first(
                extracted_first.replace(r"^\s*$", np.nan, regex=True)
            ).fillna("")
        else:
            processed_df["First name"] = extracted_first

        if "last name" in processed_df.columns:
            processed_df["last name"] = processed_df["last name"].replace(r"^\s*$", np.nan, regex=True).combine_first(
                extracted_last.replace(r"^\s*$", np.nan, regex=True)
            ).fillna("")
        else:
            processed_df["last name"] = extracted_last

        processed_df = processed_df.drop(columns=["Client's Full name"])
    elif "First name" not in processed_df.columns:
        processed_df['First name'] = ""
        processed_df['last name'] = ""

    # 3. Add default constant columns
    if "is doorpull" not in processed_df.columns:
        processed_df['is doorpull'] = True
    else:
        processed_df['is doorpull'] = processed_df['is doorpull'].fillna(True)

    if "State" not in processed_df.columns:
        processed_df['State'] = "AZ"
    else:
        processed_df['State'] = processed_df['State'].replace(r"^\s*$", np.nan, regex=True).fillna("AZ")
    
    # 4. Add missing columns if they don't exist
    for col in ["Company domain", "phone", "email", "company name", "contact owner"]:
        if col not in processed_df.columns:
            processed_df[col] = ""

    # Force all text columns to 'object' dtype so pandas doesn't complain when we insert strings like "+1 206..." into a column it thought was numeric
    text_columns = ["company name", "address", "city", "zip", "phone", "email", "State", "Company domain", "contact owner", "First name", "last name"]
    for col in text_columns:
        if col in processed_df.columns:
            # If the column was read as float, it might have trailing .0 (e.g., 85381.0)
            if col in ["zip", "phone"]:
                processed_df[col] = processed_df[col].astype(str).str.replace(r'\.0$', '', regex=True)
                processed_df[col] = processed_df[col].replace('nan', '')
            processed_df[col] = processed_df[col].astype(object)

    # 5. Enrich missing data using Google Places & Apollo
    
    # Generic email domains that we shouldn't use to search for a company
    generic_domains = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "cox.net", "icloud.com", "me.com", "mac.com", "live.com", "msn.com"]
    
    for index, row in processed_df.iterrows():
        company_name = row.get("company name", "")
        
        # We try to enrich if domain is missing
        if pd.isna(row.get("Company domain")) or str(row.get("Company domain")).strip() == "":
            if not pd.isna(company_name) and str(company_name).strip() != "":
                
                # Get address info for the search
                address = str(row.get("address", "")) if pd.notna(row.get("address")) else ""
                city = str(row.get("city", "")) if pd.notna(row.get("city")) else ""
                zip_code = str(row.get("zip", "")) if pd.notna(row.get("zip")) else ""
                
                # Extract domain from email if available
                email = str(row.get("email", "")).strip()
                domain_to_search = ""
                if "@" in email:
                    extracted = email.split("@")[-1].lower().strip()
                    if extracted not in generic_domains:
                        domain_to_search = extracted
                        
                # Immediately use the extracted domain if we found one
                if domain_to_search:
                    processed_df.at[index, "Company domain"] = domain_to_search

                # --- STEP 1: Try Google Places ---
                enriched_data = search_google_places(company_name, city)
                
                # Apply whatever data we successfully found
                if enriched_data:
                    # Update domain if we didn't extract one from the email
                    if enriched_data.get("Company domain") and not domain_to_search:
                        processed_df.at[index, "Company domain"] = enriched_data["Company domain"]
                    
                    # Fill in missing contact/location info
                    for field in ["phone", "city", "address", "zip"]:
                        if pd.isna(row.get(field)) or str(row.get(field)).strip() == "":
                            if enriched_data.get(field):
                                processed_df.at[index, field] = enriched_data[field]
                
                # --- STEP 2: Last Resort Web Scraper ---
                if not processed_df.at[index, "Company domain"]:
                    scraped_domain = scrape_company_domain(company_name)
                    processed_df.at[index, "Company domain"] = scraped_domain

    # Reorder columns to a clean format if desired
    desired_order = [
        "Date of last door pull", "contact owner", "company name", 
        "address", "city", "State", "zip", 
        "First name", "last name", "email", "Company domain", "phone", "is doorpull"
    ]
    
    # Ensure all desired columns exist and reorder
    for col in desired_order:
        if col not in processed_df.columns:
            processed_df[col] = ""
            
    # Keep only desired columns and reorder
    processed_df = processed_df[desired_order]
    
    return processed_df
