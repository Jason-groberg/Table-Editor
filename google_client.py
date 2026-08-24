import os
import requests
import streamlit as st

def get_google_api_key():
    try:
        return st.secrets["google"]["api_key"]
    except (FileNotFoundError, KeyError):
        return os.environ.get("GOOGLE_API_KEY", "")

def search_google_places(company_name, city=""):
    """
    Search Google Places API for a company to find its website, phone, and address.
    """
    api_key = get_google_api_key()
    if not api_key or api_key == "YOUR_NEW_GOOGLE_KEY":
        return {}

    # Step 1: Find the Place ID
    search_query = f"{company_name} {city} Arizona".strip()
    find_place_url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json"
    find_params = {
        "input": search_query,
        "inputtype": "textquery",
        "fields": "place_id",
        "key": api_key
    }
    
    try:
        find_response = requests.get(find_place_url, params=find_params)
        if find_response.status_code == 200:
            find_data = find_response.json()
            candidates = find_data.get("candidates", [])
            
            if not candidates:
                return {}
                
            place_id = candidates[0].get("place_id")
            
            # Step 2: Get Place Details (Phone, Website, Address)
            details_url = "https://maps.googleapis.com/maps/api/place/details/json"
            details_params = {
                "place_id": place_id,
                "fields": "formatted_phone_number,website,address_component,formatted_address",
                "key": api_key
            }
            
            details_response = requests.get(details_url, params=details_params)
            if details_response.status_code == 200:
                details_data = details_response.json().get("result", {})
                
                # Parse address components to get city and zip
                found_city = ""
                found_zip = ""
                street_number = ""
                route = ""
                
                for component in details_data.get("address_components", []):
                    types = component.get("types", [])
                    if "locality" in types:
                        found_city = component.get("long_name")
                    elif "postal_code" in types:
                        found_zip = component.get("long_name")
                    elif "street_number" in types:
                        street_number = component.get("long_name")
                    elif "route" in types:
                        route = component.get("long_name")
                        
                street_address = f"{street_number} {route}".strip()
                if not street_address:
                    street_address = details_data.get("formatted_address", "").split(",")[0]
                
                # Extract domain from website URL
                website = details_data.get("website", "")
                domain = ""
                if website:
                    # Basic extraction of domain from e.g., https://www.example.com/
                    domain = website.replace("https://", "").replace("http://", "").replace("www.", "").split("/")[0]

                return {
                    "Company domain": domain,
                    "phone": details_data.get("formatted_phone_number", ""),
                    "State": "AZ",
                    "city": found_city,
                    "address": street_address,
                    "zip": found_zip
                }
        else:
            print(f"Google API search failed: {find_response.text}")
            
    except Exception as e:
        print(f"Google Places API error for {company_name}: {e}")
        
    return {}
