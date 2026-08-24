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

def process_data(df):
    """
    Process the raw dataframe into the HubSpot ready format.
    """
    # 1. Rename columns according to mapping
    column_mapping = {
        "Date added": "Date of last door pull",
        "AM-Sup": "contact owner",
        "Account Name": "company name",
        "Building address": "address",
        "Building City": "city",
        "Building zip code": "zip",
        "Client's email.": "email",
        "Client's Phone number.": "phone"
    }
    
    # Only rename columns that exist in the dataframe
    rename_dict = {k: v for k, v in column_mapping.items() if k in df.columns}
    processed_df = df.rename(columns=rename_dict)
    
    # 2. Split "Client's Full name" into "First name" and "last name"
    if "Client's Full name" in processed_df.columns:
        names = processed_df["Client's Full name"].apply(split_name)
        processed_df['First name'] = [n[0] for n in names]
        processed_df['last name'] = [n[1] for n in names]
        processed_df = processed_df.drop(columns=["Client's Full name"])
    elif "First name" not in processed_df.columns:
        processed_df['First name'] = ""
        processed_df['last name'] = ""

    # 3. Add default constant columns
    processed_df['is doorpull'] = True
    processed_df['State'] = "AZ"
    
    # 4. Add missing columns if they don't exist
    for col in ["Company domain", "phone", "email", "company name"]:
        if col not in processed_df.columns:
            processed_df[col] = ""

    # Force all text columns to 'object' dtype so pandas doesn't complain when we insert strings like "+1 206..." into a column it thought was numeric
    text_columns = ["company name", "address", "city", "zip", "phone", "email", "State", "Company domain"]
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
